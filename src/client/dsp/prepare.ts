/**
 * prepare() — the identical front end for BOTH the uploaded target and every
 * rendered candidate. See PLAN.md "Render-and-analyze path".
 *
 * mono-sum -> peak-normalize -> trim lead (-50 dBFS) and tail (-60 dBFS)
 *          -> re-normalize the trimmed region -> cap at STFT.maxDurationSec
 *
 * Trimming BOTH sides of the comparison is load-bearing: a target with 80 ms of
 * pre-roll otherwise reports a phantom 80 ms attack error on every iteration and
 * the agent chases it forever. Running the candidate through the same code path
 * means any extractor bug hits both signals equally and cancels.
 *
 * No Web Audio here. `AudioBufferLike` is a structural type, so this is callable
 * from a plain Node test with a Float32Array.
 */

import { STFT } from "../../shared/features";

export interface PreparedAudio {
  data: Float32Array;
  sampleRate: number;
}

/** Structural shape of an AudioBuffer — deliberately NOT the DOM type. */
export interface AudioBufferLike {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Envelope detector window for silence trimming (~5.8 ms at 44.1k). */
const TRIM_WIN = 256;
const LEAD_THRESHOLD = 10 ** (-50 / 20); // -50 dBFS
const TAIL_THRESHOLD = 10 ** (-60 / 20); // -60 dBFS

function isBufferLike(v: unknown): v is AudioBufferLike {
  return typeof v === "object" && v !== null && typeof (v as AudioBufferLike).getChannelData === "function";
}

/** Average all channels down to one. Returns a fresh Float32Array. */
function monoSum(buf: AudioBufferLike): Float32Array {
  const n = buf.length;
  const ch = Math.max(1, buf.numberOfChannels);
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const src = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += src[i];
  }
  if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
  return out;
}

function peakOf(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

function normalizeInPlace(x: Float32Array): void {
  const p = peakOf(x);
  if (p <= 1e-9 || !Number.isFinite(p)) return; // silence: leave alone rather than divide by ~0
  const g = 1 / p;
  for (let i = 0; i < x.length; i++) x[i] *= g;
}

/**
 * Short-window RMS envelope, evaluated at every sample index by a running sum.
 * Cheap and stable — a bare per-sample abs() threshold triggers on the zero
 * crossings of a loud low note and trims off the attack.
 */
function envelopeRms(x: Float32Array, win: number): Float32Array {
  const n = x.length;
  const env = new Float32Array(n);
  if (n === 0) return env;
  const half = Math.max(1, win >> 1);
  let acc = 0;
  let count = 0;
  // Prime the window over [0, half).
  for (let i = 0; i < Math.min(half, n); i++) {
    acc += x[i] * x[i];
    count++;
  }
  for (let i = 0; i < n; i++) {
    const add = i + half;
    if (add < n) {
      acc += x[add] * x[add];
      count++;
    }
    const drop = i - half;
    if (drop >= 0) {
      acc -= x[drop] * x[drop];
      count--;
    }
    env[i] = count > 0 ? Math.sqrt(Math.max(0, acc) / count) : 0;
  }
  return env;
}

/**
 * Prepare audio for analysis. Accepts an AudioBuffer-shaped object, or a raw
 * Float32Array plus its sample rate (the Node-testable path).
 */
export function prepare(input: AudioBufferLike | Float32Array, sampleRate?: number): PreparedAudio {
  let mono: Float32Array;
  let sr: number;

  if (isBufferLike(input)) {
    mono = monoSum(input);
    sr = input.sampleRate;
  } else {
    if (!sampleRate || !Number.isFinite(sampleRate)) {
      throw new Error("prepare(Float32Array) requires a sampleRate");
    }
    mono = Float32Array.from(input);
    sr = sampleRate;
  }

  if (!Number.isFinite(sr) || sr <= 0) throw new Error(`invalid sampleRate ${sr}`);

  // Scrub non-finite samples before anything measures them.
  for (let i = 0; i < mono.length; i++) if (!Number.isFinite(mono[i])) mono[i] = 0;

  // 1. peak-normalize (so the dBFS trim thresholds mean the same thing for
  //    a quiet upload and a hot render).
  normalizeInPlace(mono);

  // 2. trim: lead at -50 dBFS, tail at -60 dBFS (the tail threshold is lower so
  //    a natural decay isn't chopped).
  const env = envelopeRms(mono, TRIM_WIN);
  let start = 0;
  while (start < mono.length && env[start] < LEAD_THRESHOLD) start++;
  let end = mono.length;
  while (end > start && env[end - 1] < TAIL_THRESHOLD) end--;

  if (end <= start) {
    // Effectively silent. Hand back a short zero buffer rather than an empty
    // one so every downstream loop still has frames to chew on.
    return { data: new Float32Array(Math.min(mono.length, Math.round(sr * 0.1)) || 1), sampleRate: sr };
  }

  // Back the onset off by half the detector window so we keep the true attack
  // transient rather than the point where the envelope caught up with it.
  start = Math.max(0, start - (TRIM_WIN >> 1));

  // 3. cap duration
  const maxLen = Math.round(STFT.maxDurationSec * sr);
  if (end - start > maxLen) end = start + maxLen;

  const out = mono.slice(start, end);

  // 4. re-normalize the trimmed region (the pre-trim peak may have lived in
  //    material we just discarded).
  normalizeInPlace(out);

  return { data: out, sampleRate: sr };
}
