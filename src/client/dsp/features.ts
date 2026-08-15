/**
 * extractFeatures — Float32Array in, FeatureSummary out. Nothing else.
 *
 * STFT: 2048-point FFT, 512 hop, Hann, no resampling (STFT in shared/features).
 * Four time anchors (attack / early / sustain / release) rather than one frame
 * or a full spectrogram: that is what captures "bright attack that dulls into a
 * mellow sustain" — the single most FM-relevant shape — at ~300 tokens.
 *
 * THE load-bearing detail: `harmonicsDb` is dB relative to the LOUDEST HARMONIC
 * IN THAT FRAME, floored at -60. That is what makes the spectral distance
 * gain-invariant, so overall level can never leak into it and the agent never
 * reasons about absolute amplitude when it is reasoning about timbre.
 */

import {
  FRAME_LABELS,
  N_HARMONICS,
  STFT,
  type AmpEnvelope,
  type FeatureSummary,
  type FrameFeature,
} from "../../shared/features";
import { Fft, hann } from "./fft";
import { analyzePitch } from "./f0";

const DB_FLOOR = -60;
/** Frames quieter than this (relative to the peak frame) are past the end. */
const TAIL_DB = -45;
/** Bins searched either side of the predicted harmonic bin. */
const HARMONIC_SEARCH_BINS = 2;
/** Fine amplitude envelope: 256-sample window, 64-sample hop (~1.5 ms at 44.1k). */
const ENV_WIN = 256;
const ENV_HOP = 64;
/** Envelope time constants are reported in ms and saturate here. */
const MAX_ENV_MS = 4000;

// --- rounding helpers: keep the JSON at ~300-350 tokens ---------------------
function r(v: number, digits: number): number {
  if (!Number.isFinite(v)) return 0;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}
const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function toDb(amp: number, ref: number): number {
  if (!(amp > 0) || !(ref > 0)) return DB_FLOOR;
  return clamp(20 * Math.log10(amp / ref), DB_FLOOR, 0);
}

/** Fine-resolution RMS amplitude envelope, normalized so its peak is 1. */
function ampEnvelopeCurve(x: Float32Array): { env: Float64Array; hop: number } {
  const n = x.length;
  const count = Math.max(1, Math.floor((n - ENV_WIN) / ENV_HOP) + 1);
  const env = new Float64Array(count);
  let peak = 0;
  for (let k = 0; k < count; k++) {
    const s = k * ENV_HOP;
    let acc = 0;
    const len = Math.min(ENV_WIN, n - s);
    for (let i = 0; i < len; i++) acc += x[s + i] * x[s + i];
    const v = len > 0 ? Math.sqrt(acc / len) : 0;
    env[k] = v;
    if (v > peak) peak = v;
  }
  if (peak > 0) for (let k = 0; k < count; k++) env[k] /= peak;
  return { env, hop: ENV_HOP };
}

/**
 * Exponential decay time constant (ms) over [from, to], by least squares on
 * ln(amplitude). More robust than "time to reach X% of peak", which one loud
 * frame can move by 100 ms, and it maps directly onto Tone's exponential
 * envelope segments.
 */
function decayTimeMs(env: Float64Array, from: number, to: number, msPerStep: number): number {
  const a = Math.max(0, from);
  const b = Math.min(env.length - 1, to);
  if (b - a < 2) return MAX_ENV_MS;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let k = a; k <= b; k++) {
    const y = Math.log(Math.max(env[k], 1e-5));
    const t = (k - a) * msPerStep;
    n++;
    sx += t;
    sy += y;
    sxy += t * y;
    sxx += t * t;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return MAX_ENV_MS;
  const slope = (n * sxy - sx * sy) / denom; // ln-units per ms
  if (slope >= -1e-6) return MAX_ENV_MS; // flat or rising: no measurable decay
  return clamp(-1 / slope, 1, MAX_ENV_MS);
}

function ampEnvelope(x: Float32Array, sr: number): AmpEnvelope & { peakSample: number; lastSample: number } {
  const { env, hop } = ampEnvelopeCurve(x);
  const msPerStep = (hop / sr) * 1000;

  let kPeak = 0;
  for (let k = 0; k < env.length; k++) if (env[k] > env[kPeak]) kPeak = k;

  const tailLevel = 10 ** (TAIL_DB / 20);
  let kLast = env.length - 1;
  while (kLast > kPeak && env[kLast] < tailLevel) kLast--;
  const span = Math.max(1, kLast - kPeak);

  // Attack: from the first point above 10% of peak up to the peak.
  let kOnset = 0;
  while (kOnset < kPeak && env[kOnset] < 0.1) kOnset++;
  const attackMs = Math.max(0, (kPeak - kOnset) * msPerStep);

  // Sustain: the median level over the middle of the post-peak span.
  const sA = kPeak + Math.round(0.45 * span);
  const sB = kPeak + Math.round(0.7 * span);
  const seg: number[] = [];
  for (let k = Math.min(sA, env.length - 1); k <= Math.min(sB, env.length - 1); k++) seg.push(env[k]);
  seg.sort((p, q) => p - q);
  const sustainLevel = seg.length ? seg[seg.length >> 1] : 0;

  const decayMs = decayTimeMs(env, kPeak, kPeak + Math.round(0.35 * span), msPerStep);
  const releaseMs = decayTimeMs(env, kPeak + Math.round(0.7 * span), kLast, msPerStep);

  return {
    attackMs: r0(attackMs),
    decayMs: r0(decayMs),
    sustainLevel: r(clamp(sustainLevel, 0, 1), 2),
    releaseMs: r0(releaseMs),
    peakSample: kPeak * hop,
    lastSample: kLast * hop,
  };
}

interface Peak {
  freq: number;
  amp: number;
}

/**
 * Find the harmonic near `targetHz`: pick the largest bin within +/-2 bins, then
 * parabolic-interpolate on the LOG magnitudes (that is the interpolation that
 * recovers a Hann-windowed peak's true amplitude to ~0.1 dB, which is exactly
 * what harmonicsDb needs).
 */
function findPeak(mags: Float64Array, targetHz: number, binHz: number): Peak {
  const center = targetHz / binHz;
  const lo = Math.max(1, Math.floor(center) - HARMONIC_SEARCH_BINS);
  const hi = Math.min(mags.length - 2, Math.ceil(center) + HARMONIC_SEARCH_BINS);
  if (hi <= lo) return { freq: targetHz, amp: 0 };

  let best = lo;
  for (let i = lo; i <= hi; i++) if (mags[i] > mags[best]) best = i;

  const a = Math.log(Math.max(mags[best - 1], 1e-12));
  const b = Math.log(Math.max(mags[best], 1e-12));
  const c = Math.log(Math.max(mags[best + 1], 1e-12));
  const denom = a - 2 * b + c;
  let delta = 0;
  if (Math.abs(denom) > 1e-12) delta = clamp((0.5 * (a - c)) / denom, -1, 1);
  const ampLog = b - 0.25 * (a - c) * delta;

  return { freq: (best + delta) * binHz, amp: Math.exp(ampLog) };
}

export function extractFeatures(data: Float32Array, sampleRate: number): FeatureSummary {
  const sr = sampleRate;
  const N = STFT.fftSize;
  const hop = STFT.hop;

  // Zero-pad short signals so there is always at least one full frame.
  let x = data;
  if (x.length < N) {
    const padded = new Float32Array(N);
    padded.set(x);
    x = padded;
  }

  const durationMs = r0((data.length / sr) * 1000);
  const pitch = analyzePitch(x, sr);
  // Nothing periodic found (percussion, noise): fall back to a nominal 220 Hz so
  // the harmonic grid is still well-defined and both sides use the same rule.
  const f0 = pitch.f0Hz > 0 ? pitch.f0Hz : 220;

  // --- STFT -----------------------------------------------------------------
  const fft = new Fft(N);
  const win = hann(N);
  const nFrames = Math.max(1, Math.floor((x.length - N) / hop) + 1);
  const bins = (N >>> 1) + 1;
  const binHz = sr / N;

  const specs: Float64Array[] = [];
  const frameRms = new Float64Array(nFrames);
  const scratch = new Float64Array(N);
  for (let f = 0; f < nFrames; f++) {
    const s = f * hop;
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const v = s + i < x.length ? x[s + i] : 0;
      acc += v * v;
      scratch[i] = v * win[i];
    }
    frameRms[f] = Math.sqrt(acc / N);
    specs.push(fft.magnitudes(scratch, new Float64Array(bins)));
  }

  // --- amplitude envelope + anchor frames ------------------------------------
  const amp = ampEnvelope(x, sr);
  const sampleToFrame = (sample: number) => clamp(Math.round((sample - N / 2) / hop), 0, nFrames - 1);
  const fPeak = sampleToFrame(amp.peakSample);
  let fLast = sampleToFrame(amp.lastSample);
  if (fLast <= fPeak) fLast = nFrames - 1;
  const span = Math.max(0, fLast - fPeak);

  const anchorIdx = [0, 0.2, 0.55, 0.85].map((frac, i) =>
    clamp(i === 0 ? fPeak : fPeak + Math.round(frac * span), 0, nFrames - 1),
  );

  let peakRms = 0;
  for (let f = 0; f < nFrames; f++) if (frameRms[f] > peakRms) peakRms = frameRms[f];

  // --- per-frame features ----------------------------------------------------
  const nyquist = sr / 2;
  const maxHarmonic = Math.max(1, Math.floor(nyquist / f0) - 1);

  const frames: FrameFeature[] = [];
  let inharmNum = 0;
  let inharmDen = 0;
  let noiseAcc = 0;
  let oddAcc = 0;
  let evenAcc = 0;

  for (let i = 0; i < FRAME_LABELS.length; i++) {
    const fi = anchorIdx[i];
    const mags = specs[fi];

    // Harmonic peaks 1..N_HARMONICS (the ones we report).
    const peaks: Peak[] = [];
    let loudest = 0;
    for (let h = 1; h <= N_HARMONICS; h++) {
      const hz = h * f0;
      const p = hz < nyquist - binHz * 2 ? findPeak(mags, hz, binHz) : { freq: hz, amp: 0 };
      peaks.push(p);
      if (p.amp > loudest) loudest = p.amp;
    }

    const harmonicsDb = peaks.map((p) => r0(toDb(p.amp, loudest)));

    // Inharmonicity: amplitude-weighted |cents| deviation of h>=2 from h*f0.
    for (let h = 2; h <= N_HARMONICS; h++) {
      const p = peaks[h - 1];
      if (p.amp <= 0 || loudest <= 0) continue;
      const w = p.amp / loudest;
      if (w < 0.05) continue;
      const cents = Math.abs(1200 * Math.log2(p.freq / (h * f0)));
      inharmNum += w * Math.min(cents, 200);
      inharmDen += w;
    }

    // Odd/even balance from harmonics 2..12 (h1 excluded — it dominates every
    // spectrum and would push both a saw and a square towards the same number).
    for (let h = 2; h <= N_HARMONICS; h++) {
      const a = loudest > 0 ? peaks[h - 1].amp / loudest : 0;
      if (h % 2) oddAcc += a;
      else evenAcc += a;
    }

    // Noise ratio: energy outside +/-2 bins of ANY harmonic (up to Nyquist),
    // over total energy.
    let total = 0;
    for (let b = 1; b < bins; b++) total += mags[b] * mags[b];
    const harmonicMask = new Uint8Array(bins);
    for (let h = 1; h <= maxHarmonic; h++) {
      const c = Math.round((h * f0) / binHz);
      for (let d = -HARMONIC_SEARCH_BINS; d <= HARMONIC_SEARCH_BINS; d++) {
        const b = c + d;
        if (b >= 1 && b < bins) harmonicMask[b] = 1;
      }
    }
    let harmonic = 0;
    for (let b = 1; b < bins; b++) if (harmonicMask[b]) harmonic += mags[b] * mags[b];
    noiseAcc += total > 0 ? clamp(1 - harmonic / total, 0, 1) : 0;

    // Spectral centroid, expressed in harmonic numbers.
    let cNum = 0;
    let cDen = 0;
    for (let b = 1; b < bins; b++) {
      cNum += mags[b] * b * binHz;
      cDen += mags[b];
    }
    const centroidHz = cDen > 0 ? cNum / cDen : f0;

    frames.push({
      label: FRAME_LABELS[i],
      tMs: r0(((fi * hop + N / 2) / sr) * 1000),
      rmsDb: r0(toDb(frameRms[fi], peakRms)),
      centroidRatio: r(clamp(centroidHz / f0, 0, 200), 2),
      harmonicsDb,
    });
  }

  const nAnchors = FRAME_LABELS.length;
  const oddEven = oddAcc + evenAcc > 0 ? oddAcc / (oddAcc + evenAcc) : 0.5;

  return {
    sampleRate: sr,
    durationMs,
    f0Hz: r(f0, 1),
    f0Confidence: r(clamp(pitch.confidence, 0, 1), 2),
    f0DriftCents: r0(pitch.driftCents),
    amp: {
      attackMs: amp.attackMs,
      decayMs: amp.decayMs,
      sustainLevel: amp.sustainLevel,
      releaseMs: amp.releaseMs,
    },
    inharmonicityCents: r0(inharmDen > 0 ? inharmNum / inharmDen : 0),
    noiseRatio: r(noiseAcc / nAnchors, 2),
    oddEvenBalance: r(oddEven, 2),
    frames,
  };
}
