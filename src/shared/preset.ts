/**
 * The FM preset schema — the contract between the agent, the synth, and the UI.
 *
 * IMPORTANT: this module must NOT import Tone (or anything else). The Worker
 * imports it for PRESET_JSON_SCHEMA and the type; pulling a 200KB audio library
 * into the Worker bundle to get a type would be silly.
 *
 * Topology (see PLAN.md). One Tone.FMSynth whose carrier and modulator are each
 * themselves 2-op FM oscillators, giving four operators from a "2-op" synth:
 *
 *   op4 --(modulatorFm.index)--> op3 --(modulationIndex)--+
 *                                [modEnv: ADSR]           |
 *                                                         +--> op1 --> out
 *   op2 --(carrierFm.index)--------------------------------+   [ampEnv: ADSR]
 *
 * There is NO operator feedback in this engine (Tone does not have it). Density
 * and grit come from modulatorWave: 'sawtooth'|'square' + high modulationIndex
 * + a high non-integer harmonicity. This substitution must stay in sync with the
 * hint table in dsp/diff.ts and the system prompt in worker/agent.ts.
 */

export type Wave = "sine" | "triangle" | "square" | "sawtooth";
export const WAVES: readonly Wave[] = ["sine", "triangle", "square", "sawtooth"];

export interface Adsr {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

export interface InnerFm {
  ratio: number;
  index: number;
}

export interface ClaudioPreset {
  name: string;
  /** Modulator:carrier frequency ratio. Integers -> harmonic; non-integers -> bell/metallic. */
  harmonicity: number;
  /** Depth of op3 -> op1. The primary brightness control. */
  modulationIndex: number;
  carrierWave: Wave;
  modulatorWave: Wave;
  /** op2 -> op1. index 0 collapses op1 to a plain oscillator. */
  carrierFm: InnerFm;
  /** op4 -> op3. index 0 collapses op3 to a plain oscillator. */
  modulatorFm: InnerFm;
  /** op1 amplitude — the loudness shape you hear. */
  ampEnv: Adsr;
  /** op3 amplitude == modulation index == THE BRIGHTNESS CONTOUR. */
  modEnv: Adsr;
  detune: number;
  gain: number;
}

// ---------------------------------------------------------------------------
// Ranges. Single source of truth: clampPreset and PRESET_JSON_SCHEMA both use these.
// ---------------------------------------------------------------------------

export const RANGE = {
  harmonicity: [0.25, 12],
  modulationIndex: [0, 30],
  innerRatio: [0.25, 12],
  innerIndex: [0, 12],
  envTime: [0.001, 4],
  sustain: [0, 1],
  detune: [-100, 100],
  gain: [0, 1],
} as const;

export const DEFAULT_PRESET: ClaudioPreset = {
  name: "Init",
  harmonicity: 1,
  modulationIndex: 4,
  carrierWave: "sine",
  modulatorWave: "sine",
  carrierFm: { ratio: 1, index: 0 },
  modulatorFm: { ratio: 1, index: 0 },
  ampEnv: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.6 },
  modEnv: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.4 },
  detune: 0,
  gain: 0.8,
};

/** Archetypes — used as UI starting points and as few-shot anchors for the agent. */
export const FACTORY_PRESETS: ClaudioPreset[] = [
  {
    name: "Glassy Bell",
    harmonicity: 3.47,
    modulationIndex: 14,
    carrierWave: "sine",
    modulatorWave: "sine",
    carrierFm: { ratio: 1, index: 0 },
    modulatorFm: { ratio: 2.01, index: 3 },
    ampEnv: { attack: 0.001, decay: 2.4, sustain: 0, release: 1.6 },
    modEnv: { attack: 0.001, decay: 0.5, sustain: 0.08, release: 0.5 },
    detune: 0,
    gain: 0.8,
  },
  {
    name: "Tine Piano",
    harmonicity: 2,
    modulationIndex: 7,
    carrierWave: "sine",
    modulatorWave: "sine",
    carrierFm: { ratio: 1, index: 0 },
    modulatorFm: { ratio: 1, index: 0 },
    ampEnv: { attack: 0.002, decay: 1.2, sustain: 0.12, release: 0.8 },
    modEnv: { attack: 0.001, decay: 0.18, sustain: 0.02, release: 0.3 },
    detune: 0,
    gain: 0.85,
  },
  {
    name: "Brass Swell",
    harmonicity: 1,
    modulationIndex: 9,
    carrierWave: "sine",
    modulatorWave: "triangle",
    carrierFm: { ratio: 1, index: 0 },
    modulatorFm: { ratio: 1, index: 1.5 },
    ampEnv: { attack: 0.08, decay: 0.3, sustain: 0.8, release: 0.35 },
    modEnv: { attack: 0.16, decay: 0.4, sustain: 0.65, release: 0.35 },
    detune: 0,
    gain: 0.8,
  },
];

// ---------------------------------------------------------------------------
// clampPreset — MANDATORY. The agent authors these values, and an AudioParam
// assigned NaN throws and permanently poisons the node. Never skip this.
// ---------------------------------------------------------------------------

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function wave(v: unknown, fallback: Wave): Wave {
  return typeof v === "string" && (WAVES as readonly string[]).includes(v)
    ? (v as Wave)
    : fallback;
}

function adsr(v: unknown, d: Adsr): Adsr {
  const o = (v ?? {}) as Partial<Adsr>;
  const [tLo, tHi] = RANGE.envTime;
  return {
    attack: num(o.attack, d.attack, tLo, tHi),
    decay: num(o.decay, d.decay, tLo, tHi),
    sustain: num(o.sustain, d.sustain, ...RANGE.sustain),
    release: num(o.release, d.release, tLo, tHi),
  };
}

function inner(v: unknown, d: InnerFm): InnerFm {
  const o = (v ?? {}) as Partial<InnerFm>;
  return {
    ratio: num(o.ratio, d.ratio, ...RANGE.innerRatio),
    index: num(o.index, d.index, ...RANGE.innerIndex),
  };
}

/** Coerce arbitrary (agent-authored) input into a preset that cannot break the audio graph. */
export function clampPreset(raw: unknown): ClaudioPreset {
  const p = (raw ?? {}) as Partial<ClaudioPreset>;
  const d = DEFAULT_PRESET;
  return {
    name: typeof p.name === "string" && p.name.trim() ? p.name.slice(0, 40) : d.name,
    harmonicity: num(p.harmonicity, d.harmonicity, ...RANGE.harmonicity),
    modulationIndex: num(p.modulationIndex, d.modulationIndex, ...RANGE.modulationIndex),
    carrierWave: wave(p.carrierWave, d.carrierWave),
    modulatorWave: wave(p.modulatorWave, d.modulatorWave),
    carrierFm: inner(p.carrierFm, d.carrierFm),
    modulatorFm: inner(p.modulatorFm, d.modulatorFm),
    ampEnv: adsr(p.ampEnv, d.ampEnv),
    modEnv: adsr(p.modEnv, d.modEnv),
    detune: num(p.detune, d.detune, ...RANGE.detune),
    gain: num(p.gain, d.gain, ...RANGE.gain),
  };
}

// ---------------------------------------------------------------------------
// JSON Schema for the agent tool call.
//
// NOTE: with strict:true every property must appear in `required` and every
// object needs additionalProperties:false. Numeric minimum/maximum are NOT
// enforced by strict structured outputs — they are advisory only, which is
// exactly why clampPreset above is mandatory rather than belt-and-braces.
// ---------------------------------------------------------------------------

const ADSR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["attack", "decay", "sustain", "release"],
  properties: {
    attack: { type: "number", minimum: 0.001, maximum: 4, description: "Seconds." },
    decay: { type: "number", minimum: 0.001, maximum: 4, description: "Seconds." },
    sustain: { type: "number", minimum: 0, maximum: 1, description: "Level held while the note is down, 0-1." },
    release: { type: "number", minimum: 0.001, maximum: 4, description: "Seconds after note-off." },
  },
} as const;

const INNER_FM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ratio", "index"],
  properties: {
    ratio: { type: "number", minimum: 0.25, maximum: 12, description: "Frequency ratio of this inner modulator." },
    index: {
      type: "number",
      minimum: 0,
      maximum: 12,
      description: "Modulation depth. 0 turns this inner operator OFF (the host becomes a plain oscillator).",
    },
  },
} as const;

export const PRESET_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "harmonicity",
    "modulationIndex",
    "carrierWave",
    "modulatorWave",
    "carrierFm",
    "modulatorFm",
    "ampEnv",
    "modEnv",
    "detune",
    "gain",
  ],
  properties: {
    name: { type: "string", description: "Short evocative patch name, e.g. 'Glassy Bell'. Max 40 chars." },
    harmonicity: {
      type: "number",
      minimum: 0.25,
      maximum: 12,
      description:
        "Modulator:carrier frequency ratio — sets sideband SPACING. Integers give harmonic, pitched, " +
        "instrument-like spectra (1 = full/hollow, 2 = odd-harmonic clarinet-ish, 3 = nasal). " +
        "Non-integers (1.41, 3.47, 7.13) give inharmonic bell / metallic / clangorous spectra.",
    },
    modulationIndex: {
      type: "number",
      minimum: 0,
      maximum: 30,
      description:
        "Depth of the main modulator. THE primary brightness control — raising it adds sidebands, " +
        "so more partials and a brighter, denser tone. 0 = pure sine, 2-6 warm, 10-20 bright, 20+ aggressive.",
    },
    carrierWave: { type: "string", enum: ["sine", "triangle", "square", "sawtooth"], description: "Carrier (op1) waveform." },
    modulatorWave: {
      type: "string",
      enum: ["sine", "triangle", "square", "sawtooth"],
      description:
        "Modulator (op3) waveform. sawtooth/square make the modulator spectrally dense, which is how " +
        "you get gritty, noisy timbres in this engine — there is NO operator feedback available.",
    },
    carrierFm: { ...INNER_FM_SCHEMA, description: "Inner FM on the carrier (op2 -> op1). Adds body/edge to the carrier itself." },
    modulatorFm: { ...INNER_FM_SCHEMA, description: "Inner FM on the modulator (op4 -> op3). Enriches the modulator, adding upper partials." },
    ampEnv: { ...ADSR_SCHEMA, description: "Carrier amplitude envelope — the LOUDNESS shape you hear." },
    modEnv: {
      ...ADSR_SCHEMA,
      description:
        "Modulator amplitude envelope — this IS the BRIGHTNESS CONTOUR over time. A modEnv decay shorter " +
        "than the ampEnv decay gives the classic 'bright attack that mellows out' of struck and plucked sounds.",
    },
    detune: { type: "number", minimum: -100, maximum: 100, description: "Cents." },
    gain: { type: "number", minimum: 0, maximum: 1, description: "Output level." },
  },
} as const;
