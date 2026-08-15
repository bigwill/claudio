/**
 * Offline render: preset -> PreparedAudio, through the SAME prepare() the target
 * goes through, so any extractor bug affects both signals equally and cancels.
 *
 * Tone.Offline gotchas honoured here (PLAN.md "Render-and-analyze path"):
 *   1. It swaps the GLOBAL Tone context (setContext(offline) ... setContext(orig))
 *      and is NOT concurrency-safe. Every render goes through the module-level
 *      promise queue below. Mandatory — overlapping calls produce silent or
 *      corrupted buffers, the worst failure mode inside a measurement loop.
 *   2. The synth is constructed INSIDE the callback and connected with
 *      .toDestination(). A node built outside belongs to the live context and
 *      renders pure silence, with no error.
 *   3. channels and sampleRate are passed EXPLICITLY (defaults are 2 and the
 *      live context's rate).
 *   4. It resolves to a ToneAudioBuffer, not an AudioBuffer — use .get().
 *   5. portamento = 0 (set in presetToOptions) or the pitch glides into the note
 *      and corrupts attack-frame analysis.
 *   6. OfflineContext has lookAhead 0 and starts at _currentTime 0, so time 0 is
 *      genuinely frame 0 — no lead-in to compensate for.
 */

import * as Tone from "tone";
import { clampPreset, type ClaudioPreset } from "../../shared/preset";
import { prepare, type PreparedAudio } from "../dsp/prepare";
import { buildVoice } from "./voice";

export type { PreparedAudio } from "../dsp/prepare";

export interface RenderSpec {
  /** Fundamental to render at, in Hz — the target's detected f0. */
  f0: number;
  /** Total buffer length to render, ms. Capped at MAX_RENDER_MS. */
  durationMs: number;
  /** Render sample rate — the target's rate. Never hardcode 44100. */
  sampleRate: number;
  /** Note-on duration, ms. Usually durationMs minus the amp release. */
  gateMs: number;
  /** 0..1, default 0.9. */
  velocity?: number;
}

/** Keeps the agent loop responsive; PLAN.md risk 5. */
export const MAX_RENDER_MS = 2500;

// --- the serialization queue ------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();
let inFlight = 0;

/** True while a Tone.Offline callback may be executing. No live note should be
 *  triggered during that window (the global context is swapped out). */
export function isRendering(): boolean {
  return inFlight > 0;
}

/** Resolves when the render queue has drained. */
export function renderIdle(): Promise<void> {
  return queue.then(
    () => undefined,
    () => undefined,
  );
}

/** Run `job` with exclusive access to the global Tone context. */
function serialize<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  // Keep the chain alive even when a job rejects, or one bad preset wedges
  // every subsequent render.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  inFlight++;
  return run.finally(() => {
    inFlight--;
  });
}

// --- render -----------------------------------------------------------------

function clampSpec(spec: RenderSpec) {
  const f0 = Number.isFinite(spec.f0) && spec.f0 > 0 ? Math.min(8000, Math.max(20, spec.f0)) : 220;
  const durationMs = Number.isFinite(spec.durationMs)
    ? Math.min(MAX_RENDER_MS, Math.max(100, spec.durationMs))
    : 1200;
  const sampleRate =
    Number.isFinite(spec.sampleRate) && spec.sampleRate > 0
      ? Math.min(96000, Math.max(8000, Math.round(spec.sampleRate)))
      : 44100;
  const gateMs = Number.isFinite(spec.gateMs)
    ? Math.min(durationMs, Math.max(20, spec.gateMs))
    : Math.max(20, durationMs - 200);
  const velocity =
    typeof spec.velocity === "number" && Number.isFinite(spec.velocity)
      ? Math.min(1, Math.max(0.01, spec.velocity))
      : 0.9;
  return { f0, durationMs, sampleRate, gateMs, velocity };
}

/**
 * Render one note of `preset` and return it prepared for feature extraction.
 * Serialized against every other render.
 */
export function renderPreset(preset: ClaudioPreset, spec: RenderSpec): Promise<PreparedAudio> {
  const p = clampPreset(preset);
  const s = clampSpec(spec);

  return serialize(async () => {
    const buffer = await Tone.Offline(
      () => {
        // MUST be constructed in here. See gotcha 2.
        const voice = buildVoice(p).toDestination();
        voice.triggerAttackRelease(s.f0, s.gateMs / 1000, 0, s.velocity);
      },
      s.durationMs / 1000,
      1, // channels — explicit, gotcha 3
      s.sampleRate, // explicit, gotcha 3
    );

    const audioBuffer = buffer.get(); // gotcha 4
    if (!audioBuffer) throw new Error("render produced no buffer");
    return prepare(audioBuffer);
  });
}
