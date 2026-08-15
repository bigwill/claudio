/**
 * The analysis contract: what the browser measures, and what the agent reads.
 *
 * Pure types + constants. No Web Audio, no Tone, no DOM — the Worker imports
 * this too. See PLAN.md "Audio analysis layer".
 *
 * Design rule for everything here: it must be small enough to sit in a prompt
 * (~300-350 tokens for a FeatureSummary, ~450 for a FeatureDiff) and every
 * field must be something a musician could name out loud.
 */

export type FrameLabel = "attack" | "early" | "sustain" | "release";
export const FRAME_LABELS: readonly FrameLabel[] = ["attack", "early", "sustain", "release"];

/** Harmonics tracked per frame. h=1 is the fundamental. */
export const N_HARMONICS = 12;

/** STFT parameters. Target and candidate MUST be analyzed identically. */
export const STFT = {
  fftSize: 2048,
  hop: 512,
  /** Analysis is capped so a long sample can't stall the loop. */
  maxDurationSec: 4,
} as const;

export interface FrameFeature {
  label: FrameLabel;
  /** ms from onset (post-trim). Integer. */
  tMs: number;
  /** dB relative to the peak frame. <= 0, floored at -60. Integer. */
  rmsDb: number;
  /** Spectral centroid expressed in harmonic numbers: 1.0 = pure sine, 6.0 = very bright. */
  centroidRatio: number;
  /**
   * Exactly N_HARMONICS integers, dB relative to the LOUDEST HARMONIC IN THIS FRAME,
   * floored at -60. Frame-relative is what makes these gain-invariant — overall level
   * can never leak into the spectral distance. Do not change this to absolute dB.
   */
  harmonicsDb: number[];
}

export interface AmpEnvelope {
  attackMs: number;
  decayMs: number;
  /** 0..1 */
  sustainLevel: number;
  releaseMs: number;
}

export interface FeatureSummary {
  sampleRate: number;
  durationMs: number;
  f0Hz: number;
  /** 0..1. Below ~0.5 means unpitched/percussive — treat f0-derived fields with suspicion. */
  f0Confidence: number;
  /** Stdev of f0 across the sound, in cents. High = vibrato or glide. */
  f0DriftCents: number;
  amp: AmpEnvelope;
  /** 0 = perfectly harmonic; >30 = bell/metallic. Drives non-integer harmonicity. */
  inharmonicityCents: number;
  /** 0..1 fraction of energy outside harmonic peaks. */
  noiseRatio: number;
  /** Odd-harmonic energy / total harmonic energy. >0.7 = square/clarinet-like. */
  oddEvenBalance: number;
  /** Exactly FRAME_LABELS.length entries, in that order. */
  frames: FrameFeature[];
}

// ---------------------------------------------------------------------------
// Diff — what actually steers the agent.
// Design rule: every entry names a direction to move AND a ClaudioPreset field
// that would move it. A number with no attached action is wasted tokens.
// ---------------------------------------------------------------------------

export type Direction = "increase" | "decrease";

export type ScalarName =
  | "attackMs"
  | "decayMs"
  | "sustainLevel"
  | "releaseMs"
  | "durationMs"
  | "f0Cents"
  | "inharmonicityCents"
  | "noiseRatio"
  | "oddEvenBalance"
  | "centroid.attack"
  | "centroid.early"
  | "centroid.sustain"
  | "centroid.release"
  | "rms.early"
  | "rms.sustain"
  | "rms.release";

export interface ScalarDiff {
  name: ScalarName;
  target: number;
  got: number;
  /** got - target. Negative means the candidate is under the target. */
  delta: number;
  unit: "ms" | "dB" | "cents" | "ratio" | "x";
  direction: Direction;
  /** 0..1 normalized contribution to `distance`. */
  severity: number;
  hint: string;
}

export interface HarmonicDiff {
  frame: FrameLabel;
  h: number;
  targetDb: number;
  gotDb: number;
  /** got - target. Negative means too quiet. */
  deltaDb: number;
  hint: string;
}

export interface FeatureDiff {
  /** 0..100, lower is better. Below ~12 is a good match. */
  distance: number;
  breakdown: { spectrum: number; envelope: number; pitch: number; noise: number };
  /** One sentence, plain English. */
  verdict: string;
  /** 3-5 ordered plain-English fixes. The agent reads this first. */
  priorities: string[];
  scalars: ScalarDiff[];
  harmonics: HarmonicDiff[];
}

/** Distance weights. Spectrum dominates because that's what the preset controls. */
export const DISTANCE_WEIGHTS = {
  spectrum: 0.55,
  envelope: 0.25,
  pitch: 0.1,
  noise: 0.1,
} as const;

/** Reporting thresholds — keeps the diff small enough to stay readable. */
export const DIFF_LIMITS = {
  minScalarSeverity: 0.08,
  maxScalars: 8,
  minHarmonicDeltaDb: 5,
  maxHarmonics: 8,
  /** distance below this counts as converged */
  goodMatch: 12,
} as const;
