/**
 * Hand-written iterative radix-2 FFT.
 *
 * PURE MATH. No Web Audio, no Tone, no DOM — see PLAN.md "three boundaries".
 * That is what makes the whole extractor runnable under plain `node`.
 *
 * Bit-reversal and twiddle tables are precomputed once per size and reused
 * across every frame of the STFT (a 4 s sample at 512 hop is ~340 frames, so
 * rebuilding the tables per frame would dominate the cost).
 */

const TWO_PI = Math.PI * 2;

export class Fft {
  readonly n: number;
  private readonly rev: Uint32Array;
  private readonly cosT: Float64Array;
  private readonly sinT: Float64Array;
  /** Scratch buffers so callers can run a whole STFT without allocating. */
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`fft size must be a power of two, got ${n}`);
    this.n = n;
    const levels = Math.round(Math.log2(n));

    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
      this.rev[i] = r;
    }

    const half = n >>> 1;
    this.cosT = new Float64Array(half);
    this.sinT = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosT[i] = Math.cos((TWO_PI * i) / n);
      this.sinT[i] = Math.sin((TWO_PI * i) / n);
    }

    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** In-place forward complex FFT. Arrays must be length n. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    const rev = this.rev;
    const cosT = this.cosT;
    const sinT = this.sinT;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cosT[k];
          const s = sinT[k];
          const tre = re[l] * c + im[l] * s;
          const tim = -re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  /**
   * Magnitude spectrum of a real, already-windowed frame.
   *
   * `frame` must be length n. Writes n/2+1 magnitudes into `out` (allocated if
   * omitted) and returns it. Magnitudes are raw (unnormalized) — every feature
   * downstream is a ratio, so the scale never escapes this file.
   */
  magnitudes(frame: ArrayLike<number>, out?: Float64Array): Float64Array {
    const n = this.n;
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < n; i++) {
      re[i] = frame[i] ?? 0;
      im[i] = 0;
    }
    this.transform(re, im);
    const bins = (n >>> 1) + 1;
    const mags = out ?? new Float64Array(bins);
    for (let i = 0; i < bins; i++) mags[i] = Math.hypot(re[i], im[i]);
    return mags;
  }
}

/** Periodic Hann window of length n. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / n);
  return w;
}
