/**
 * THE public audio API. The UI and the transport layer import this module and
 * nothing else under audio/ — it owns Tone, all AudioContext lifecycle, and all
 * clamping. (PLAN.md "Repo layout", third boundary.)
 *
 *   analyzeTarget(file)                  -> features + prepared audio for a new session
 *   specForTarget / specForPrompt        -> mint a session's render spec, ONCE
 *   evaluateWithSpec(preset, spec, tgt)  -> features + diff, against the SESSION's spec
 *   playNote / setLivePreset             -> live audition
 *   renderTwiceIdentical(...)            -> determinism smoke test, run once on boot
 *
 * The spec/evaluate split is what makes this multiplayer-safe: the spec is minted
 * once by whoever starts the session and stored server-side, and every other
 * contributor renders against that same spec rather than one derived from their
 * own hardware.
 */

import type { FeatureDiff, FeatureSummary } from "../../shared/features";
import type { RenderSpec, TargetInfo } from "../../shared/protocol";
import { clampPreset, type ClaudioPreset } from "../../shared/preset";
import { diffFeatures } from "../dsp/diff";
import { extractFeatures } from "../dsp/features";
import { prepare } from "../dsp/prepare";
import { renderPreset, renderIdle, type PreparedAudio } from "./render";
import * as voice from "./voice";

export type { PreparedAudio } from "./render";
export type { RenderSpec } from "../../shared/protocol";
export { presetToOptions, buildVoice, ensureAudio, setLivePreset, stopLive, disposeLive, midiToHz, noteOn, noteOff } from "./voice";
export { renderPreset, renderIdle, isRendering, MAX_RENDER_MS } from "./render";

export interface TargetAnalysis {
  features: FeatureSummary;
  prepared: PreparedAudio;
  info: TargetInfo;
}

export interface PresetEvaluation {
  features: FeatureSummary;
  /** null when there is no target — prompt-started sessions. */
  diff: FeatureDiff | null;
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
// Sharing the target
//
// The prepared buffer is mono, trimmed, peak-normalized and capped at 4s, so
// 16-bit PCM keeps a typical target well under half a megabyte. The sample rate
// is NOT stored alongside it — it already travels in the FeatureSummary, and
// having one authority for it is what keeps a re-decode honest.
// ---------------------------------------------------------------------------

/** Float32 [-1,1] -> little-endian Int16. Halves the payload, inaudible loss. */
export function encodePreparedAudio(prepared: PreparedAudio): ArrayBuffer {
  const src = prepared.data;
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    // Asymmetric scaling: Int16 runs -32768..32767, so the negative side gets
    // the larger multiplier. Using 32767 for both would clip the trough.
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

export function decodePreparedAudio(bytes: ArrayBuffer, sampleRate: number): PreparedAudio {
  const src = new Int16Array(bytes);
  const data = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    data[i] = src[i] < 0 ? src[i] / 0x8000 : src[i] / 0x7fff;
  }
  return { data, sampleRate };
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
 * The render spec for a prompt-started session, where there is no target to
 * inherit f0 / duration / sample rate from. A3 for ~1.5s is a neutral audition
 * pitch — low enough to hear a bass, high enough to hear a bell.
 */
export function specForPrompt(): RenderSpec {
  return {
    f0: 220,
    durationMs: 1500,
    sampleRate: getAudioContext().sampleRate,
    gateMs: 1000,
  };
}

/**
 * Render a preset against the session's pinned spec and measure it.
 *
 * THE SPEC COMES FROM THE SESSION, not from this browser. specForTarget /
 * specForPrompt above are for MINTING a spec once, when a session is created;
 * from then on every contributor renders against that same stored spec.
 *
 * That distinction is the whole point. specForPrompt() reads the live
 * AudioContext's sample rate, so if each browser derived its own spec, two
 * contributors on 44.1 kHz and 48 kHz hardware would measure the same session at
 * different FFT bin resolutions and STFT frame alignments — and diffFeatures
 * would compare those numbers anyway, feeding the agent a difference it would
 * attribute to its own parameter change. Tone.Offline takes sampleRate
 * explicitly (render.ts gotcha 3), so a pinned spec makes renders comparable
 * across machines.
 *
 * `targetFeatures` is null for prompt-started sessions: the agent still learns
 * what its patch actually came out as, there is simply no distance to minimise.
 */
export async function evaluateWithSpec(
  preset: ClaudioPreset,
  spec: RenderSpec,
  targetFeatures: FeatureSummary | null,
): Promise<PresetEvaluation> {
  const p = clampPreset(preset);
  const prepared = await renderPreset(p, spec);
  const features = extractFeatures(prepared.data, prepared.sampleRate);
  const diff = targetFeatures ? diffFeatures(targetFeatures, features) : null;
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
