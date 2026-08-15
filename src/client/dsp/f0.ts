/**
 * Pitch detection — YIN-lite (cumulative-mean-normalized square difference).
 *
 * Deliberately NOT an FFT peak pick. At 2048/44.1k the bin spacing is 21.5 Hz;
 * for a 55 Hz sample that is ~40% of the fundamental, and an f0 that is off by
 * even 5% puts harmonic 12 a whole bin-and-a-half away from where we search for
 * it — which silently corrupts every harmonicsDb value downstream. Time domain
 * costs ~40 lines and is accurate to a fraction of a percent. See PLAN.md.
 */

export interface F0Estimate {
  /** Hz. 0 when nothing periodic was found in range. */
  f0: number;
  /** 0..1 — 1 - the normalized difference at the chosen lag. */
  confidence: number;
}

export interface PitchResult {
  f0Hz: number;
  confidence: number;
  /** Stdev of the per-offset estimates, in cents. High = vibrato or glide. */
  driftCents: number;
}

const F0_MIN = 50;
const F0_MAX = 2000;
/** YIN's absolute threshold. Below this we accept the first dip. */
const YIN_THRESHOLD = 0.15;
/** Offsets across the sound, as fractions of the usable span. */
const SAMPLE_POINTS = [0.05, 0.25, 0.45, 0.65, 0.85];

/**
 * Estimate f0 from one window starting at `offset`.
 *
 * The analysis window is 2x the longest lag we search, so d(tau) always has a
 * full integration window of at least tauMax samples.
 */
export function detectF0(x: Float32Array, sr: number, offset: number): F0Estimate {
  const tauMax = Math.min(Math.floor(sr / F0_MIN), Math.floor((x.length - offset) / 2));
  const tauMin = Math.max(2, Math.floor(sr / F0_MAX));
  if (tauMax <= tauMin + 2) return { f0: 0, confidence: 0 };

  const w = tauMax; // integration window length
  const start = Math.max(0, Math.min(offset, x.length - (w + tauMax)));
  if (start < 0 || start + w + tauMax > x.length) return { f0: 0, confidence: 0 };

  // Bail out on silence — otherwise d(tau) is 0/0 and every lag looks perfect.
  let energy = 0;
  for (let i = 0; i < w; i++) energy += x[start + i] * x[start + i];
  if (energy / w < 1e-10) return { f0: 0, confidence: 0 };

  // 1. squared difference function
  const d = new Float64Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < w; i++) {
      const diff = x[start + i] - x[start + i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // 2. cumulative mean normalized difference
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  for (let tau = 1; tau < tauMin; tau++) cmnd[tau] = 1;

  // 3. absolute threshold: first local minimum below YIN_THRESHOLD, else the
  //    global minimum over the search range.
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < YIN_THRESHOLD) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let lo = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < lo) {
        lo = cmnd[tau];
        best = tau;
      }
    }
  }
  if (best < 0) return { f0: 0, confidence: 0 };

  // 3b. octave guard. YIN's classic failure is locking onto a sub-multiple of
  // the true period (reporting 60 Hz for a 220 Hz clang). If a lag at best/k is
  // nearly as good, prefer it — the shorter period is the real one.
  for (let k = 4; k >= 2; k--) {
    const cand = Math.round(best / k);
    if (cand < tauMin || cand > tauMax) continue;
    let localBest = cand;
    for (let t = Math.max(tauMin, cand - 2); t <= Math.min(tauMax, cand + 2); t++) {
      if (cmnd[t] < cmnd[localBest]) localBest = t;
    }
    if (cmnd[localBest] < cmnd[best] + 0.1) {
      best = localBest;
      break;
    }
  }

  // 4. parabolic interpolation around the dip — this is what turns an integer
  //    lag into sub-0.5% pitch accuracy.
  let refined = best;
  if (best > tauMin && best < tauMax) {
    const a = cmnd[best - 1];
    const b = cmnd[best];
    const c = cmnd[best + 1];
    const denom = 2 * (2 * b - a - c);
    if (Math.abs(denom) > 1e-12) refined = best + (c - a) / denom;
  }

  const f0 = refined > 0 ? sr / refined : 0;
  if (!Number.isFinite(f0) || f0 < F0_MIN * 0.5 || f0 > F0_MAX * 2) return { f0: 0, confidence: 0 };

  return { f0, confidence: Math.max(0, Math.min(1, 1 - cmnd[best])) };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Sample f0 at 5 points across the sound. Median -> f0Hz (robust to one bad
 * frame at the attack), stdev in cents -> driftCents (vibrato / glide).
 */
export function analyzePitch(x: Float32Array, sr: number): PitchResult {
  const tauMax = Math.floor(sr / F0_MIN);
  const need = tauMax * 2;
  const usable = x.length - need;

  const ests: F0Estimate[] = [];
  if (usable <= 0) {
    ests.push(detectF0(x, sr, 0));
  } else {
    for (const frac of SAMPLE_POINTS) {
      ests.push(detectF0(x, sr, Math.floor(frac * usable)));
    }
  }

  const good = ests.filter((e) => e.f0 > 0 && e.confidence > 0.3);
  const pool = good.length > 0 ? good : ests.filter((e) => e.f0 > 0);
  if (pool.length === 0) return { f0Hz: 0, confidence: 0, driftCents: 0 };

  const f0Hz = median(pool.map((e) => e.f0));
  const confidence = median(pool.map((e) => e.confidence));

  // Drop octave errors before measuring drift, or one halved estimate reports
  // 1200 cents of "vibrato".
  const inTune = pool.filter((e) => Math.abs(1200 * Math.log2(e.f0 / f0Hz)) < 300);
  let driftCents = 0;
  if (inTune.length > 1 && f0Hz > 0) {
    const cents = inTune.map((e) => 1200 * Math.log2(e.f0 / f0Hz));
    const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
    const varc = cents.reduce((a, b) => a + (b - mean) * (b - mean), 0) / cents.length;
    driftCents = Math.sqrt(varc);
  }

  return { f0Hz, confidence, driftCents };
}
