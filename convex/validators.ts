/**
 * Convex validators for the payloads that cross the wire.
 *
 * Policy (see the port plan): validate LENIENTLY, then sanitize inside the
 * mutation. A validator that rejects throws the whole transaction, which is a
 * wedge mode the Durable Object never had — an agent-authored preset with a
 * hallucinated field would throw on every turn, forever. So numeric ranges are
 * NOT enforced here; `clampPreset()` is what enforces them, and it must run
 * before any insert.
 *
 * What IS enforced here is shape and size, because these payloads arrive from an
 * unauthenticated browser, get spliced into a Claude prompt, and get broadcast to
 * every subscriber. Array-length caps are the real protection.
 *
 * Drift protection: the `Exact<>` assertions at the bottom fail `tsc` if these
 * ever diverge from src/shared/. That is the single source of truth; this file
 * mirrors it.
 */

import { v, type Infer } from "convex/values";

import type { FeatureSummary, FrameFeature, AmpEnvelope } from "../src/shared/features";
import type { Adsr, ClaudioPreset, InnerFm } from "../src/shared/preset";

// ---------------------------------------------------------------------------
// Preset
//
// Waves use the literal union rather than v.string(): every write path runs
// clampPreset() first (which coerces an unknown wave to the default), so by the
// time a preset reaches the database the union already holds — and keeping it
// exact is what lets Infer<> match ClaudioPreset.
// ---------------------------------------------------------------------------

export const vWave = v.union(
  v.literal("sine"),
  v.literal("triangle"),
  v.literal("square"),
  v.literal("sawtooth"),
);

export const vAdsr = v.object({
  attack: v.number(),
  decay: v.number(),
  sustain: v.number(),
  release: v.number(),
});

export const vInnerFm = v.object({
  ratio: v.number(),
  index: v.number(),
});

export const vPreset = v.object({
  name: v.string(),
  harmonicity: v.number(),
  modulationIndex: v.number(),
  carrierWave: vWave,
  modulatorWave: vWave,
  carrierFm: vInnerFm,
  modulatorFm: vInnerFm,
  ampEnv: vAdsr,
  modEnv: vAdsr,
  detune: v.number(),
  gain: v.number(),
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export const vFrameLabel = v.union(
  v.literal("attack"),
  v.literal("early"),
  v.literal("sustain"),
  v.literal("release"),
);

export const vAmpEnvelope = v.object({
  attackMs: v.number(),
  decayMs: v.number(),
  sustainLevel: v.number(),
  releaseMs: v.number(),
});

export const vFrameFeature = v.object({
  label: vFrameLabel,
  tMs: v.number(),
  rmsDb: v.number(),
  /** Exactly N_HARMONICS entries — length is checked in code, not here. */
  harmonicsDb: v.array(v.number()),
  centroidRatio: v.number(),
});

export const vFeatureSummary = v.object({
  sampleRate: v.number(),
  durationMs: v.number(),
  f0Hz: v.number(),
  f0Confidence: v.number(),
  f0DriftCents: v.number(),
  amp: vAmpEnvelope,
  inharmonicityCents: v.number(),
  noiseRatio: v.number(),
  oddEvenBalance: v.number(),
  /** Exactly FRAME_LABELS.length entries, in that order. Checked in code. */
  frames: v.array(vFrameFeature),
});

// ---------------------------------------------------------------------------
// Diff
//
// Deliberately a size-bounded shallow shape rather than a faithful mirror of
// FeatureDiff. It is derived client-side FROM vFeatureSummary and is only ever
// JSON.stringify'd into a prompt — nothing re-parses it. So the threat is
// payload size, which array caps answer, not structural precision.
// ---------------------------------------------------------------------------

export const vFeatureDiff = v.object({
  distance: v.number(),
  breakdown: v.object({
    spectrum: v.number(),
    envelope: v.number(),
    pitch: v.number(),
    noise: v.number(),
  }),
  verdict: v.string(),
  priorities: v.array(v.string()),
  scalars: v.array(
    v.object({
      name: v.string(),
      target: v.number(),
      got: v.number(),
      delta: v.number(),
      unit: v.string(),
      direction: v.string(),
      severity: v.number(),
      hint: v.string(),
    }),
  ),
  harmonics: v.array(
    v.object({
      frame: vFrameLabel,
      h: v.number(),
      targetDb: v.number(),
      gotDb: v.number(),
      deltaDb: v.number(),
      hint: v.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Session-level shapes
// ---------------------------------------------------------------------------

export const vTargetInfo = v.object({
  filename: v.string(),
  durationSec: v.number(),
  sampleRate: v.number(),
});

/**
 * The render spec, persisted once per session.
 *
 * This is the fix for the one place a contributor's LOCAL hardware rate used to
 * leak into a measurement: specForPrompt() read getAudioContext().sampleRate, so
 * two contributors on 44.1k and 48k machines would measure the same session at
 * different FFT bin resolutions. Tone.Offline takes sampleRate explicitly, so
 * pinning it here makes every browser's render of a given preset comparable.
 */
export const vRenderSpec = v.object({
  f0: v.number(),
  durationMs: v.number(),
  sampleRate: v.number(),
  gateMs: v.number(),
});

export const vStatus = v.union(
  v.literal("idle"),
  v.literal("thinking"),
  v.literal("awaiting_render"),
  v.literal("done"),
  v.literal("error"),
);

export const vChatKind = v.union(v.literal("user"), v.literal("agent"), v.literal("system"));

export const vChatStatus = v.union(
  v.literal("queued"),
  v.literal("sent"),
  v.literal("cancelled"),
);

/** Attribution only. Spoofable by design — never used for access control. */
export const vContributor = v.object({
  clientId: v.string(),
  nickname: v.string(),
  color: v.string(),
});

// ---------------------------------------------------------------------------
// Drift guards.
//
// These are type-level only — they compile to nothing. If src/shared/ gains or
// renames a field and this file doesn't, `tsc` fails here rather than at some
// runtime validation error three layers away.
// ---------------------------------------------------------------------------

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _adsr: Exact<Infer<typeof vAdsr>, Adsr> = true;
const _inner: Exact<Infer<typeof vInnerFm>, InnerFm> = true;
const _preset: Exact<Infer<typeof vPreset>, ClaudioPreset> = true;
const _ampEnv: Exact<Infer<typeof vAmpEnvelope>, AmpEnvelope> = true;
const _frame: Exact<Infer<typeof vFrameFeature>, FrameFeature> = true;
const _features: Exact<Infer<typeof vFeatureSummary>, FeatureSummary> = true;

// Reference them so noUnusedLocals doesn't strip the guards.
void [_adsr, _inner, _preset, _ampEnv, _frame, _features];
