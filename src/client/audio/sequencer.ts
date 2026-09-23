/**
 * The band's musical logic: pure, no Tone import, unit-tested in Node.
 *
 * One clock and one tick drive every track. The engine calls
 * `schedulerStep(state, g)` once per sixteenth with the global step `g`, and
 * gets back the next state plus what to promote and what to play. Because every
 * track is stepped in the same call, tracks cannot drift, and every staged
 * change promotes on a shared line: part changes on the next BAR line (so a
 * change never waits out a whole 4-bar loop), harmony changes on the next LOOP
 * line (a bar-count change moves the loop origin, which only makes sense there).
 *
 * Staging sets `landsAtG` once, at stage time, from the last step processed.
 * The countdown the UI shows ("lands in N beats") is derived from the same
 * number, so the countdown and the landing can't disagree.
 */

import {
  accentedVel,
  chordRootDegree,
  degreeToMidi,
  ROLE_OCTAVE,
  STEPS_PER_BAR,
  type BandRole,
  type DrumHit,
  type DrumVoice,
  type LengthBars,
  type Pattern,
  type PitchedNote,
  type Scale,
} from "../../shared/pattern";

/** Tone's default PPQ is 192, so one sixteenth is 48 ticks. The engine checks this. */
export const STEP_TICKS = 48;

export type TrackId = BandRole;
export const TRACKS: readonly TrackId[] = ["drums", "bass", "keys"];

export interface Harmony {
  bpm: number;
  keyPc: number;
  scale: Scale;
  /** Chord roots as scale degrees, one per bar, cycling. */
  progression: number[];
  bars: LengthBars;
}

/** What the engine stages: one part version, keyed by content. */
export interface PartRef {
  /** Identity of the content (the part's `basedOn`); the engine restages only when it changes. */
  id: string;
  /** Identity of the instrument (library id); null for the kit. */
  sound: string | null;
  role: TrackId;
  pattern: Pattern;
}

export interface TrackState {
  current: PartRef | null;
  staged: PartRef | null;
  landsAtG: number | null;
}

export interface SeqState {
  harmony: Harmony;
  stagedHarmony: Harmony | null;
  harmonyLandsAtG: number | null;
  tracks: Record<TrackId, TrackState>;
  /** The last step processed; -1 before the first. */
  lastG: number;
  /** Loop origin: the step where s = 0. Moves when the bar count changes. */
  g0: number;
}

export type SeqEvent =
  | { type: "tempo"; bpm: number }
  | { type: "attack"; track: TrackId; midi: number; durTicks: number; vel: number }
  | { type: "hit"; track: TrackId; voice: DrumVoice; vel: number };

export type Promotion = { kind: "part"; track: TrackId; part: PartRef } | { kind: "harmony"; harmony: Harmony };

export interface StepResult {
  state: SeqState;
  promotions: Promotion[];
  events: SeqEvent[];
}

const emptyTrack = (): TrackState => ({ current: null, staged: null, landsAtG: null });

export function initialState(harmony: Harmony): SeqState {
  return {
    harmony,
    stagedHarmony: null,
    harmonyLandsAtG: null,
    tracks: { drums: emptyTrack(), bass: emptyTrack(), keys: emptyTrack() },
    lastG: -1,
    g0: 0,
  };
}

export function loopSteps(h: Harmony): number {
  return h.bars * STEPS_PER_BAR;
}

/** The first loop line after the last processed step (0 before the first step). */
export function nextLoopLine(state: SeqState): number {
  const L = loopSteps(state.harmony);
  return state.g0 + (Math.floor((state.lastG - state.g0) / L) + 1) * L;
}

/** The first bar line after the last processed step (0 before the first step). */
export function nextBarLine(state: SeqState): number {
  return state.g0 + (Math.floor((state.lastG - state.g0) / STEPS_PER_BAR) + 1) * STEPS_PER_BAR;
}

export function stage(state: SeqState, track: TrackId, part: PartRef): SeqState {
  return {
    ...state,
    tracks: { ...state.tracks, [track]: { ...state.tracks[track], staged: part, landsAtG: nextBarLine(state) } },
  };
}

export function stageHarmony(state: SeqState, harmony: Harmony): SeqState {
  return { ...state, stagedHarmony: harmony, harmonyLandsAtG: nextLoopLine(state) };
}

/** Steps between the next step to be processed and the landing; null if nothing is staged. */
export function stepsUntilLanding(state: SeqState, track: TrackId): number | null {
  const t = state.tracks[track];
  return t.staged && t.landsAtG !== null ? Math.max(0, t.landsAtG - (state.lastG + 1)) : null;
}

/**
 * For a (re)start from g=0: every current part is staged again so it promotes
 * on the first step, and any staged harmony applies immediately.
 */
export function resetForStart(state: SeqState): SeqState {
  const tracks = {} as Record<TrackId, TrackState>;
  for (const id of TRACKS) {
    const t = state.tracks[id];
    const part = t.staged ?? t.current;
    tracks[id] = { current: null, staged: part, landsAtG: part ? 0 : null };
  }
  return {
    harmony: state.stagedHarmony ?? state.harmony,
    stagedHarmony: null,
    harmonyLandsAtG: null,
    tracks,
    lastG: -1,
    g0: 0,
  };
}

export function schedulerStep(state: SeqState, g: number): StepResult {
  const promotions: Promotion[] = [];
  const events: SeqEvent[] = [];
  let { harmony, stagedHarmony, harmonyLandsAtG, g0 } = state;

  // Harmony first, so this step's parts play in the new key, tempo and loop.
  if (stagedHarmony && harmonyLandsAtG !== null && g >= harmonyLandsAtG) {
    if (stagedHarmony.bars !== harmony.bars) g0 = harmonyLandsAtG;
    if (stagedHarmony.bpm !== harmony.bpm) events.push({ type: "tempo", bpm: stagedHarmony.bpm });
    harmony = stagedHarmony;
    promotions.push({ kind: "harmony", harmony });
    stagedHarmony = null;
    harmonyLandsAtG = null;
  }

  const tracks = { ...state.tracks };
  for (const id of TRACKS) {
    const t = tracks[id];
    if (t.staged && t.landsAtG !== null && g >= t.landsAtG) {
      tracks[id] = { current: t.staged, staged: null, landsAtG: null };
      promotions.push({ kind: "part", track: id, part: t.staged });
    }
  }

  const s = (((g - g0) % loopSteps(harmony)) + loopSteps(harmony)) % loopSteps(harmony);
  const root = chordRootDegree(harmony.progression, Math.floor(s / STEPS_PER_BAR));
  for (const id of TRACKS) {
    const part = tracks[id].current;
    if (!part) continue;
    const ps = s % (part.pattern.lengthBars * STEPS_PER_BAR);
    if (part.role === "drums") {
      for (const h of part.pattern.notes as DrumHit[]) {
        if (h.step === ps) events.push({ type: "hit", track: id, voice: h.voice, vel: accentedVel(h.vel, h.accent) });
      }
    } else {
      const octave = ROLE_OCTAVE[part.role];
      for (const n of part.pattern.notes as PitchedNote[]) {
        if (n.step !== ps) continue;
        events.push({
          type: "attack",
          track: id,
          midi: degreeToMidi(harmony.keyPc, harmony.scale, root + n.deg, octave),
          durTicks: n.len * STEP_TICKS,
          vel: accentedVel(n.vel, n.accent),
        });
      }
    }
  }

  return {
    state: { harmony, stagedHarmony, harmonyLandsAtG, tracks, lastG: g, g0 },
    promotions,
    events,
  };
}
