/**
 * The band's instruments, behind one small interface so the engine can wrap
 * them in a spy and E2E can check what was actually played.
 *
 * Every node is built on the context the engine passes in, never the global
 * one, so a `Tone.Offline` render can't capture a live instrument (and the
 * onset test can build the whole engine on an offline context).
 */

import * as Tone from "tone";

import type { DrumVoice } from "../../shared/pattern";
import { clampPreset, type ClaudioPreset } from "../../shared/preset";
import { midiToHz, presetToOptions } from "./voice";

export interface Instrument {
  /** Timed note; `durSec` is already converted at the engine's current tempo. */
  attackRelease(midi: number, durSec: number, time: number, vel: number): void;
  attack(midi: number, time: number, vel: number): void;
  release(midi: number, time: number): void;
  hit(voice: DrumVoice, time: number, vel: number): void;
  releaseAll(time: number): void;
  /** Longest release tail in seconds, for scheduling dispose after a swap. */
  readonly tail: number;
  readonly output: Tone.ToneAudioNode;
  dispose(): void;
}

/** Band keys releases are capped so a swap doesn't leave long tails ringing. */
export const KEYS_MAX_RELEASE = 1.5;

function withContext<T extends object>(options: T, context: Tone.BaseContext): T & { context: Tone.BaseContext } {
  return { ...options, context };
}

/** Monophonic FM bass. Portamento stays 0 (presetToOptions), or notes glide by accident. */
export function buildBass(preset: ClaudioPreset, context: Tone.BaseContext): Instrument {
  const p = clampPreset(preset);
  const synth = new Tone.FMSynth(withContext(presetToOptions(p), context));
  return {
    attackRelease: (midi, dur, time, vel) => synth.triggerAttackRelease(midiToHz(midi), dur, time, vel),
    attack: (midi, time, vel) => synth.triggerAttack(midiToHz(midi), time, vel),
    release: (_midi, time) => synth.triggerRelease(time),
    hit: () => {},
    releaseAll: (time) => synth.triggerRelease(time),
    tail: p.ampEnv.release,
    output: synth,
    dispose: () => synth.dispose(),
  };
}

/**
 * Polyphonic FM (band keys, and your live sound). PolySynth DROPS notes past
 * maxPolyphony rather than stealing voices. Voices are pre-warmed here, off the
 * audio path, so the first chord in a tick doesn't construct nodes.
 */
export function buildPoly(
  preset: ClaudioPreset,
  context: Tone.BaseContext,
  opts: { maxPolyphony: number; maxRelease?: number; prewarm?: number },
): Instrument {
  const p = clampPreset(preset);
  const release = opts.maxRelease ? Math.min(p.ampEnv.release, opts.maxRelease) : p.ampEnv.release;
  const capped = { ...p, ampEnv: { ...p.ampEnv, release } };
  const poly = new Tone.PolySynth({
    voice: Tone.FMSynth,
    options: presetToOptions(capped),
    maxPolyphony: opts.maxPolyphony,
    context,
  });
  const warm = opts.prewarm ?? 0;
  if (warm > 0) {
    // Silent notes allocate the voices now instead of inside a tick.
    const notes = Array.from({ length: warm }, (_, i) => midiToHz(48 + i));
    poly.triggerAttackRelease(notes, 0.01, context.currentTime, 0);
  }
  return {
    attackRelease: (midi, dur, time, vel) => poly.triggerAttackRelease(midiToHz(midi), dur, time, vel),
    attack: (midi, time, vel) => poly.triggerAttack(midiToHz(midi), time, vel),
    release: (midi, time) => poly.triggerRelease(midiToHz(midi), time),
    hit: () => {},
    releaseAll: (time) => poly.releaseAll(time),
    tail: release,
    output: poly,
    dispose: () => poly.dispose(),
  };
}

/**
 * The kit: a sampled 808 kick (velocity reaches it through the Sampler), a
 * synthesized snare (noise + membrane) and one MetalSynth for hat and open hat,
 * which differ only in decay. That's why a step has at most one of the two.
 */
export function buildKit(kick: AudioBuffer, context: Tone.BaseContext): Instrument {
  const out = new Tone.Gain({ gain: 1, context });
  const kickS = new Tone.Sampler({ urls: { C1: kick }, context }).connect(out);
  const snareNoise = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.02 },
    volume: -12,
    context,
  }).connect(out);
  const snareBody = new Tone.MembraneSynth({
    pitchDecay: 0.02,
    octaves: 3,
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.02 },
    volume: -10,
    context,
  }).connect(out);
  const metal = new Tone.MetalSynth({
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
    // sustain 0, so the decay (not the gate) sets the length: hat 50ms, open hat 350ms.
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
    volume: -24,
    context,
  }).connect(out);

  // Tone throws when a source starts twice at the same time, which late steps
  // can produce; nudge each voice past its previous start.
  const last: Record<DrumVoice, number> = { kick: -1, snare: -1, hat: -1, openhat: -1 };
  const guard = (voice: DrumVoice, time: number) => {
    const t = Math.max(time, last[voice] + 1e-3);
    last[voice] = t;
    return t;
  };

  return {
    attackRelease: () => {},
    attack: () => {},
    release: () => {},
    hit: (voice, time, vel) => {
      const t = guard(voice, time);
      if (voice === "kick") kickS.triggerAttack("C1", t, vel);
      else if (voice === "snare") {
        snareNoise.triggerAttackRelease(0.1, t, vel);
        snareBody.triggerAttackRelease(180, 0.1, t, vel);
      } else {
        const decay = voice === "hat" ? 0.05 : 0.35;
        metal.envelope.decay = decay;
        metal.triggerAttackRelease(300, decay, t, vel);
      }
    },
    releaseAll: (time) => {
      kickS.releaseAll(time);
      metal.triggerRelease(time);
    },
    tail: 1,
    output: out,
    dispose: () => [kickS, snareNoise, snareBody, metal, out].forEach((n) => n.dispose()),
  };
}

export interface SpyCall {
  g: number;
  time: number;
  track: string;
  method: "attack" | "attackRelease" | "release" | "hit" | "releaseAll";
  note: number | string | null;
}

/** Records every call before forwarding it, so tests see what the engine played. */
export function spy(inner: Instrument, track: string, log: SpyCall[], getG: () => number, cap = 20_000): Instrument {
  const rec = (method: SpyCall["method"], time: number, note: number | string | null) => {
    if (log.length < cap) log.push({ g: getG(), time, track, method, note });
  };
  return {
    attackRelease: (midi, dur, time, vel) => (rec("attackRelease", time, midi), inner.attackRelease(midi, dur, time, vel)),
    attack: (midi, time, vel) => (rec("attack", time, midi), inner.attack(midi, time, vel)),
    release: (midi, time) => (rec("release", time, midi), inner.release(midi, time)),
    hit: (voice, time, vel) => (rec("hit", time, voice), inner.hit(voice, time, vel)),
    releaseAll: (time) => (rec("releaseAll", time, null), inner.releaseAll(time)),
    get tail() {
      return inner.tail;
    },
    output: inner.output,
    dispose: () => inner.dispose(),
  };
}
