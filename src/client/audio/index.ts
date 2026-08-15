/**
 * THE public audio API. The UI and the transport layer import this module and
 * nothing else under audio/ — it owns Tone, all AudioContext lifecycle, and all
 * clamping. (PLAN.md "Repo layout", third boundary.)
 *
 *   analyzeTarget(file)            -> features for the agent; the audio stays local
 *   evaluatePreset(preset, target) -> features + diff for the agent
 *   playNote / setLivePreset       -> live audition
 *   renderTwiceIdentical(...)      -> determinism smoke test, run once on boot
 */

import type { FeatureDiff, FeatureSummary } from "../../shared/features";
import type { TargetInfo } from "../../shared/protocol";
import { clampPreset, type ClaudioPreset } from "../../shared/preset";
import { diffFeatures } from "../dsp/diff";
import { extractFeatures } from "../dsp/features";
import { prepare } from "../dsp/prepare";
import { renderPreset, renderIdle, type PreparedAudio, type RenderSpec } from "./render";
import * as voice from "./voice";

export type { PreparedAudio, RenderSpec } from "./render";
export { presetToOptions, buildVoice, ensureAudio, setLivePreset, stopLive, disposeLive, midiToHz, noteOn, noteOff } from "./voice";
export { renderPreset, renderIdle, isRendering, MAX_RENDER_MS } from "./render";

export interface TargetAnalysis {
  features: FeatureSummary;
  prepared: PreparedAudio;
  info: TargetInfo;
}

export interface PresetEvaluation {
  features: FeatureSummary;
  diff: FeatureDiff;
  prepared: PreparedAudio;
}

// ---------------------------------------------------------------------------
// One shared live AudioContext.
//
// decodeAudioData RESAMPLES to the decoding context's rate, so whatever rate
// this context happens to run at becomes the project's rate. Never hardcode
// 44100: read buffer.sampleRate after decoding and use it everywhere downstream.
// ---------------------------------------------------------------------------

let sharedCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedCtx) {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/**
 * Decode an uploaded file, run it through prepare(), and extract features.
 * Needs no user gesture — a suspended AudioContext still decodes.
 */
export async function analyzeTarget(file: File): Promise<TargetAnalysis> {
  const ctx = getAudioContext();
  const bytes = await file.arrayBuffer();
  const decoded = await ctx.decodeAudioData(bytes);

  // buffer.sampleRate, not ctx.sampleRate and never a literal.
  const prepared = prepare(decoded, decoded.sampleRate);
  const features = extractFeatures(prepared.data, prepared.sampleRate);

  return {
    features,
    prepared,
    info: {
      filename: file.name,
      durationSec: prepared.data.length / prepared.sampleRate,
      sampleRate: prepared.sampleRate,
    },
  };
}

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/** The render spec a candidate must use to be comparable to this target. */
export function specForTarget(target: TargetAnalysis): RenderSpec {
  const f = target.features;
  const durationMs = f.durationMs;
  const releaseMs = Number.isFinite(f.amp?.releaseMs) ? f.amp.releaseMs : 0;
  return {
    f0: f.f0Hz,
    durationMs,
    sampleRate: f.sampleRate || target.prepared.sampleRate,
    gateMs: Math.max(20, durationMs - releaseMs),
  };
}

/**
 * Render a candidate preset at the target's f0 / duration / sample rate, extract
 * the same features, and diff. This is the whole feedback half of the loop.
 */
export async function evaluatePreset(
  preset: ClaudioPreset,
  target: TargetAnalysis,
): Promise<PresetEvaluation> {
  const p = clampPreset(preset);
  const prepared = await renderPreset(p, specForTarget(target));
  const features = extractFeatures(prepared.data, prepared.sampleRate);
  const diff = diffFeatures(target.features, features);
  return { features, diff, prepared };
}

// ---------------------------------------------------------------------------
// Determinism self-check (PLAN.md: at ~minute 12, not later)
//
// If renders aren't deterministic, every iteration of the agent loop afterwards
// is chasing noise and we need to know immediately. Tone should be deterministic
// here — oscillator phase defaults to 0, envelopes are scheduled AudioParam
// ramps, nothing random — but assert it rather than assume it.
// ---------------------------------------------------------------------------

export async function renderTwiceIdentical(
  preset: ClaudioPreset,
  spec: RenderSpec,
): Promise<boolean> {
  const p = clampPreset(preset);
  const a = await renderPreset(p, spec);
  const b = await renderPreset(p, spec);
  const fa = extractFeatures(a.data, a.sampleRate);
  const fb = extractFeatures(b.data, b.sampleRate);
  return Math.abs(diffFeatures(fa, fb).distance) < 1e-6;
}

// ---------------------------------------------------------------------------
// Live playback
// ---------------------------------------------------------------------------

/**
 * Audition a preset live. Async because no live note may be triggered while a
 * Tone.Offline callback is executing — Offline swaps the global context out from
 * under the live nodes (PLAN.md risk 7).
 *
 * `ensureAudio()` must have been called from a user gesture at least once.
 */
export async function playNote(midi = 60, velocity = 0.9, durSec = 1.2): Promise<void> {
  await renderIdle();
  voice.playNote(midi, velocity, durSec);
}

/** Convenience: set the live preset and immediately play it. */
export async function auditionPreset(
  preset: ClaudioPreset,
  midi = 60,
  velocity = 0.9,
  durSec = 1.2,
): Promise<void> {
  await voice.ensureAudio();
  await renderIdle();
  voice.setLivePreset(preset);
  voice.playNote(midi, velocity, durSec);
}

// ---------------------------------------------------------------------------
// A/B audition — turn prepared (trimmed, normalized) audio back into something
// playable, so the user hears exactly the signal the features were computed on.
// ---------------------------------------------------------------------------

export function toAudioBuffer(prepared: PreparedAudio): AudioBuffer {
  const ctx = getAudioContext();
  // createBuffer accepts a rate different from the context's; playback resamples.
  const buf = ctx.createBuffer(1, Math.max(1, prepared.data.length), prepared.sampleRate);
  // .set() rather than copyToChannel: avoids the Float32Array<ArrayBufferLike>
  // vs Float32Array<ArrayBuffer> variance mismatch in TS 5.9's DOM lib.
  buf.getChannelData(0).set(prepared.data);
  return buf;
}

/** Play prepared audio through the shared context. Returns a stop function. */
export function playBuffer(prepared: PreparedAudio): () => void {
  const ctx = getAudioContext();
  const src = ctx.createBufferSource();
  src.buffer = toAudioBuffer(prepared);
  src.connect(ctx.destination);
  src.start();
  return () => {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  };
}

/** @deprecated alias — use playBuffer. */
export const playPrepared = playBuffer;
