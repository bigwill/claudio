/**
 * Band patterns: what a musician's step sequencer holds. Pure; imports nothing,
 * because the agents' tools (Convex), the sequencer (browser) and the prompt
 * snapshot all share it.
 *
 * Pitched notes are CHORD-RELATIVE scale degrees: the sounding pitch is
 * `degreeToMidi(key, scale, chordRoot(bar) + deg, octave)`, so `deg 0/2/4` are
 * always the chord's root, third and fifth, and a 1-bar part follows the chords.
 */

export const STEPS_PER_BAR = 16;
export const LENGTH_BARS = [1, 2, 4] as const;
export type LengthBars = (typeof LENGTH_BARS)[number];

export type PitchedRole = "bass" | "keys";
export type BandRole = "drums" | PitchedRole;

export const DRUM_VOICES = ["kick", "snare", "hat", "openhat"] as const;
export type DrumVoice = (typeof DRUM_VOICES)[number];

export interface PitchedNote {
  step: number;
  /** Chord-relative scale degree. */
  deg: number;
  /** Length in steps. */
  len: number;
  vel: number;
  accent: boolean;
  /** Wave 2 (slice 10). Forced false until then. */
  tie: boolean;
}

export interface DrumHit {
  step: number;
  voice: DrumVoice;
  vel: number;
  accent: boolean;
}

export interface PitchedPattern {
  lengthBars: LengthBars;
  notes: PitchedNote[];
}

export interface DrumPattern {
  lengthBars: LengthBars;
  notes: DrumHit[];
}

export type Pattern = PitchedPattern | DrumPattern;

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
} as const;
export type Scale = keyof typeof SCALES;

/** Ties ship in wave 2; until then clampPattern forces them off. */
export const TIES_ENABLED = false;
export const MAX_NOTES = 256;
export const MAX_PER_STEP: Record<PitchedRole, number> = { bass: 1, keys: 4 };
export const ROLE_OCTAVE: Record<PitchedRole, number> = { bass: 2, keys: 4 };
export const DEG_RANGE = [-7, 14] as const;
export const DEFAULT_VEL = 0.8;
export const ACCENT_BOOST = 0.25;

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Scale degree (any integer, 0 = tonic) to MIDI. Octave 4 puts C4 at 60. */
export function degreeToMidi(keyPc: number, scale: Scale, degree: number, octave: number): number {
  const steps = SCALES[scale];
  const d = Math.round(degree);
  return 12 * (octave + 1) + keyPc + steps[mod(d, 7)] + 12 * Math.floor(d / 7);
}

/**
 * The chord root for a loop bar, as a scale degree wrapped into -3..3 so parts
 * stay near the tonic (in D minor, a Bb chord's bass is Bb1, not Bb2).
 */
export function chordRootDegree(progression: readonly number[], bar: number): number {
  if (progression.length === 0) return 0;
  const r = mod(Math.round(progression[mod(bar, progression.length)]), 7);
  return r > 3 ? r - 7 : r;
}

export function accentedVel(vel: number, accent: boolean): number {
  return accent ? Math.min(1, vel + ACCENT_BOOST) : vel;
}

// ---------------------------------------------------------------------------
// clampPattern: clamps and never rejects. Unusable notes are dropped.
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function finite(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function lengthBarsOf(v: unknown): LengthBars {
  const n = finite(v);
  if (n === null) return 1;
  return LENGTH_BARS.find((b) => b >= n) ?? 4;
}

function velOf(v: unknown): number {
  const n = finite(v);
  return n === null ? DEFAULT_VEL : Math.min(1, Math.max(0.05, n));
}

function stepOf(v: unknown, partSteps: number): number | null {
  const n = finite(v);
  if (n === null) return null;
  const s = Math.round(n);
  return s >= 0 && s < partSteps ? s : null;
}

function notesOf(raw: unknown): Raw[] {
  const notes = (raw as Raw | null)?.notes;
  return Array.isArray(notes) ? notes.filter((n): n is Raw => typeof n === "object" && n !== null) : [];
}

export function clampPattern(role: "drums", raw: unknown): DrumPattern;
export function clampPattern(role: PitchedRole, raw: unknown): PitchedPattern;
export function clampPattern(role: BandRole, raw: unknown): Pattern;
export function clampPattern(role: BandRole, raw: unknown): Pattern {
  const r = typeof raw === "object" && raw !== null ? (raw as Raw) : {};
  const lengthBars = lengthBarsOf(r.lengthBars);
  const partSteps = lengthBars * STEPS_PER_BAR;
  return role === "drums"
    ? { lengthBars, notes: clampDrums(notesOf(r), partSteps) }
    : { lengthBars, notes: clampPitched(notesOf(r), partSteps, MAX_PER_STEP[role]) };
}

function clampDrums(raw: Raw[], partSteps: number): DrumHit[] {
  const seen = new Set<string>();
  const out: DrumHit[] = [];
  for (const n of raw) {
    if (out.length >= MAX_NOTES) break;
    const step = stepOf(n.step, partSteps);
    const voice = (DRUM_VOICES as readonly unknown[]).includes(n.voice) ? (n.voice as DrumVoice) : null;
    if (step === null || voice === null) continue;
    // hat and openhat share one MetalSynth, so they share a slot.
    const slot = `${step}:${voice === "openhat" ? "hat" : voice}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    out.push({ step, voice, vel: velOf(n.vel), accent: n.accent === true });
  }
  return out.sort((a, b) => a.step - b.step || DRUM_VOICES.indexOf(a.voice) - DRUM_VOICES.indexOf(b.voice));
}

function clampPitched(raw: Raw[], partSteps: number, perStep: number): PitchedNote[] {
  const seen = new Set<string>();
  const count = new Map<number, number>();
  const out: PitchedNote[] = [];
  for (const n of raw) {
    if (out.length >= MAX_NOTES) break;
    const step = stepOf(n.step, partSteps);
    const d = finite(n.deg);
    if (step === null || d === null) continue;
    const deg = Math.min(DEG_RANGE[1], Math.max(DEG_RANGE[0], Math.round(d)));
    if (seen.has(`${step}:${deg}`) || (count.get(step) ?? 0) >= perStep) continue;
    seen.add(`${step}:${deg}`);
    count.set(step, (count.get(step) ?? 0) + 1);
    const len = Math.min(partSteps, Math.max(1, Math.round(finite(n.len) ?? 1)));
    out.push({ step, deg, len, vel: velOf(n.vel), accent: n.accent === true, tie: TIES_ENABLED && n.tie === true });
  }
  return out.sort((a, b) => a.step - b.step || a.deg - b.deg);
}

// ---------------------------------------------------------------------------
// summarizePattern: explicit step lists, for the agents' snapshot and the rail.
// ---------------------------------------------------------------------------

export function summarizePattern(role: BandRole, p: Pattern): string {
  const head = `${p.lengthBars} bar${p.lengthBars === 1 ? "" : "s"}`;
  if (p.notes.length === 0) return `${head} · lays out`;
  if (role === "drums") {
    const hits = p.notes as DrumHit[];
    const rows = DRUM_VOICES.map((voice) => {
      const steps = hits.filter((h) => h.voice === voice).map((h) => `${h.step}${h.accent ? "X" : ""}`);
      return steps.length ? `${voice} ${steps.join(",")}` : null;
    }).filter(Boolean);
    return [head, ...rows].join(" · ");
  }
  const notes = (p.notes as PitchedNote[]).map(
    (n) => `${n.step}:${n.deg}${n.len > 1 ? `/${n.len}` : ""}${n.accent ? "X" : ""}${n.tie ? "~" : ""}`,
  );
  return `${head} · ${notes.join(" ")}`;
}
