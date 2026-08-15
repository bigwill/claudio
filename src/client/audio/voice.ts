/**
 * preset -> Tone mapping, plus the live (audible) voice.
 *
 * Topology (PLAN.md "Getting 4 operators out of a '2-operator' synth"):
 *
 *   op4 --(modulatorFm.index)--> op3 --(modulationIndex)--+
 *                                [modEnv]                 |
 *                                                         +--> op1 --> out
 *   op2 --(carrierFm.index)--------------------------------+   [ampEnv]
 *
 * One Tone.FMSynth. Its `oscillator` (op1) and `modulation` (op3) are each an
 * OmniOscillator; setting either to an `fm*` type turns it into a 2-op
 * FMOscillator with its own harmonicity/modulationIndex — op2 and op4.
 *
 * HARD RULE: build from a constructor options object, never by mutating after
 * construction. `harmonicity`/`modulationIndex` do not exist on an
 * OmniOscillator until its `type` has been set to an `fm*` variant, so mutation
 * ordering silently drops them.
 */

import * as Tone from "tone";
import { clampPreset, DEFAULT_PRESET, type ClaudioPreset, type Wave } from "../../shared/preset";

/** `RecursivePartial<Tone.FMSynthOptions>` — taken off the constructor so we
 *  don't depend on Tone re-exporting its internal `RecursivePartial` helper. */
export type FMSynthPartialOptions = NonNullable<ConstructorParameters<typeof Tone.FMSynth>[0]>;

/** 0..1 linear -> Tone's dB `volume`. Floored so gain 0 can't produce -Infinity. */
export function gainToDb(gain: number): number {
  const g = Number.isFinite(gain) ? gain : 1;
  return 20 * Math.log10(Math.max(1e-4, g));
}

/** MIDI note -> Hz. A4 (69) = 440. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * An operator pair: the host oscillator's own wave, plus its inner modulator.
 * `index === 0` collapses to a plain oscillator (`'sine'` rather than `'fmsine'`),
 * which is the documented meaning of index 0 in the preset schema.
 */
function oscOptions(wave: Wave, inner: { ratio: number; index: number }) {
  if (inner.index > 0) {
    return {
      type: `fm${wave}`,
      harmonicity: inner.ratio,
      modulationIndex: inner.index,
      modulationType: "sine",
      phase: 0,
    };
  }
  return { type: wave, phase: 0 };
}

/**
 * The whole preset -> Tone translation. Pure; no nodes are created here.
 * Input is clamped first — the agent authors these numbers and a NaN written to
 * an AudioParam throws and permanently poisons the node.
 */
export function presetToOptions(p: ClaudioPreset): FMSynthPartialOptions {
  const c = clampPreset(p);
  const options = {
    // portamento 0 everywhere: offline it would glide into the note and corrupt
    // the attack-frame analysis; live it just isn't wanted.
    portamento: 0,
    volume: gainToDb(c.gain),
    detune: c.detune,
    harmonicity: c.harmonicity,
    modulationIndex: c.modulationIndex,
    oscillator: oscOptions(c.carrierWave, c.carrierFm),
    modulation: oscOptions(c.modulatorWave, c.modulatorFm),
    envelope: {
      attack: c.ampEnv.attack,
      decay: c.ampEnv.decay,
      sustain: c.ampEnv.sustain,
      release: c.ampEnv.release,
    },
    modulationEnvelope: {
      attack: c.modEnv.attack,
      decay: c.modEnv.decay,
      sustain: c.modEnv.sustain,
      release: c.modEnv.release,
    },
  };
  // The OmniOscillator options type is a 14-member union that TS cannot narrow
  // from a computed `type` string. One cast, per PLAN.md; the shape above is
  // exactly OmniFMTypeOscillatorOptions / ToneTypeOscillatorOptions.
  return options as unknown as FMSynthPartialOptions;
}

/**
 * Construct the voice. NOTE: this uses whatever Tone context is current, which
 * is exactly what we want — called inside a `Tone.Offline` callback it builds an
 * offline node, called live it builds a live one. One code path, two contexts.
 */
export function buildVoice(p: ClaudioPreset): Tone.FMSynth {
  return new Tone.FMSynth(presetToOptions(p));
}

// ---------------------------------------------------------------------------
// Live playback
// ---------------------------------------------------------------------------

/**
 * The LIVE voice is polyphonic; the OFFLINE render deliberately is not.
 *
 * `buildVoice()` above returns a bare FMSynth and is what `Tone.Offline` uses —
 * the analysis renders exactly one note, and adding voices there would change
 * the thing being measured (and its level). Polyphony is a playing affordance,
 * not part of the measurement loop, so it lives only on this side.
 */
let liveVoice: Tone.PolySynth<Tone.FMSynth> | null = null;
let liveLimiter: Tone.Limiter | null = null;
let livePreset: ClaudioPreset | null = null;
let started = false;

/**
 * Resume the live AudioContext. MUST be called from a user gesture handler
 * (click/keydown) — browsers reject it otherwise. Offline rendering does NOT
 * need this, so analysis and the first render can run before any click.
 */
export async function ensureAudio(): Promise<void> {
  if (started) return;
  await Tone.start();
  started = true;
}

/**
 * Swap the live preset. Dispose + rebuild (~1ms) rather than mutating, so live
 * and offline share the single `presetToOptions` code path and can never drift.
 */
export function setLivePreset(p: ClaudioPreset): void {
  const c = clampPreset(p);
  livePreset = c;
  if (liveVoice) {
    liveVoice.dispose();
    liveVoice = null;
  }
  // Voices sum, so a six-note chord at gain 0.8 would clip hard on its own.
  // A limiter is the difference between "playable instrument" and "distorted
  // mess the moment you hold a chord" — the offline render path has no such
  // node, deliberately, since it must measure the preset and not a limiter.
  if (!liveLimiter) liveLimiter = new Tone.Limiter(-2).toDestination();
  liveVoice = new Tone.PolySynth(Tone.FMSynth, presetToOptions(c)).connect(liveLimiter);
  // Plenty for ten fingers; the cap only matters as a voice-stealing backstop.
  liveVoice.maxPolyphony = 16;
}

export function getLivePreset(): ClaudioPreset | null {
  return livePreset;
}

/**
 * Audition a note. Requires `ensureAudio()` to have run at least once.
 * Falls back to building a voice on demand if none has been set.
 */
export function playNote(midi = 60, velocity = 0.9, durSec = 1.2): void {
  // Never silently do nothing: fall back to the init patch if the UI hasn't
  // pushed a preset yet.
  if (!liveVoice) setLivePreset(livePreset ?? DEFAULT_PRESET);
  const v = Math.min(1, Math.max(0.01, Number.isFinite(velocity) ? velocity : 0.9));
  const d = Math.min(4, Math.max(0.05, Number.isFinite(durSec) ? durSec : 1.2));
  const hz = midiToHz(Number.isFinite(midi) ? midi : 60);
  liveVoice!.triggerAttackRelease(hz, d, undefined, v);
}

/**
 * Hold-to-sustain, for the on-screen keyboard. Polyphonic — each held key gets
 * its own voice, and `noteOff(midi)` releases only that one.
 */
export function noteOn(midi: number, velocity = 0.9): void {
  if (!liveVoice) setLivePreset(livePreset ?? DEFAULT_PRESET);
  const v = Math.min(1, Math.max(0.01, Number.isFinite(velocity) ? velocity : 0.9));
  const hz = midiToHz(Number.isFinite(midi) ? midi : 60);
  liveVoice!.triggerAttack(hz, undefined, v);
}

/** Release one note. Omit `midi` to release everything still sounding. */
export function noteOff(midi?: number): void {
  if (!liveVoice) return;
  if (midi === undefined) liveVoice.releaseAll();
  else liveVoice.triggerRelease(midiToHz(midi));
}

/** Release every sounding note without tearing the voice down. */
export function stopLive(): void {
  if (liveVoice) liveVoice.releaseAll();
}

/** Tear the live voice down entirely. */
export function disposeLive(): void {
  if (liveVoice) {
    liveVoice.dispose();
    liveVoice = null;
  }
}
