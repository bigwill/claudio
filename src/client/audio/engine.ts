/**
 * The band engine: the Tone layer around the pure sequencer.
 *
 * One owner. The engine owns all sequence and instrument state. Everything else
 * talks to it by message: `stage()` only enqueues into a mailbox (and builds the
 * next instrument, off the audio path). The tick drains the mailbox at the start
 * of each step and then runs `schedulerStep` on a consistent state, so an
 * update can never land in the middle of a tick.
 *
 * One clock. A single `scheduleRepeat` at "16n" drives every track, and every
 * note of a step is scheduled at that step's exact `time`, ~150ms ahead. A
 * main-thread stall longer than the lookahead makes the whole step late
 * together, never one track against another; `missedSteps` counts it.
 *
 * One context. Every node is built with the context passed in (the live one by
 * default, captured once), so a design render's `Tone.Offline` can never
 * capture a live instrument, and the onset test can run this same engine on
 * an offline context.
 */

import * as Tone from "tone";

import type { DrumVoice } from "../../shared/pattern";
import type { ClaudioPreset } from "../../shared/preset";
import { buildBass, buildKit, buildPoly, KEYS_MAX_RELEASE, spy, type Instrument, type SpyCall } from "./instruments";
import {
  initialState,
  nextLoopLine,
  resetForStart,
  schedulerStep,
  stage as seqStage,
  stageHarmony,
  STEP_TICKS,
  TRACKS,
  type Harmony,
  type PartRef,
  type SeqState,
  type TrackId,
} from "./sequencer";

export type ChannelId = TrackId | "you";
export const LOOKAHEAD_SEC = 0.15;

export interface EngineOptions {
  harmony: Harmony;
  /** The decoded 808 kick. */
  kick: AudioBuffer;
  /** Your live sound. */
  yourSound: ClaudioPreset;
  /** Defaults to the current (live) Tone context, captured once. */
  context?: Tone.BaseContext;
  /** Wrap every instrument in a recording spy. */
  spy?: boolean;
  /** Called on the draw thread's schedule for each step (not in offline renders). */
  onStep?: (g: number) => void;
}

export interface Promoted {
  g: number;
  track: TrackId;
  id: string;
}

type Mail = { kind: "part"; track: TrackId; part: PartRef } | { kind: "harmony"; harmony: Harmony };

interface Track {
  channel: Tone.Channel;
  inst: Instrument | null;
  sound: string | null;
  /** Built at stage time for a staged part with a different sound. */
  next: { sound: string | null; inst: Instrument } | null;
  /** The last part id handed to stage(), to restage only on content change. */
  stagedId: string | null;
}

export class BandEngine {
  readonly context: Tone.BaseContext;
  readonly calls: SpyCall[] = [];
  readonly promotions: Promoted[] = [];
  g = -1;
  missedSteps = 0;
  running = false;

  private seq: SeqState;
  private mailbox: Mail[] = [];
  private tracks: Record<TrackId, Track>;
  private you: { channel: Tone.Channel; inst: Instrument };
  private held = new Map<number, Instrument>();
  private master: Tone.Gain;
  private kick: AudioBuffer;
  private repeatId: number | null = null;
  readonly meter: Tone.Meter;

  constructor(private opts: EngineOptions) {
    this.context = opts.context ?? Tone.getContext();
    // Offline renders keep their own lookahead (0): time there is already exact.
    if (!(this.context instanceof Tone.OfflineContext)) this.context.lookAhead = LOOKAHEAD_SEC;
    const transport = this.context.transport;
    if (transport.PPQ / 4 !== STEP_TICKS) throw new Error(`engine expects PPQ ${STEP_TICKS * 4}, got ${transport.PPQ}`);
    this.seq = initialState(opts.harmony);
    this.kick = opts.kick;

    const ctx = this.context;
    const limiter = new Tone.Limiter({ threshold: -2, context: ctx });
    this.meter = new Tone.Meter({ context: ctx });
    this.master = new Tone.Gain({ gain: 0.9, context: ctx });
    this.master.chain(limiter, this.meter);
    limiter.connect(ctx.destination);

    const channel = (volume: number) => new Tone.Channel({ volume, context: ctx }).connect(this.master);
    this.tracks = {
      drums: { channel: channel(-3), inst: null, sound: null, next: null, stagedId: null },
      bass: { channel: channel(-6), inst: null, sound: null, next: null, stagedId: null },
      keys: { channel: channel(-10), inst: null, sound: null, next: null, stagedId: null },
    };
    const youChannel = channel(-8);
    this.you = { channel: youChannel, inst: this.wrap(buildPoly(opts.yourSound, ctx, { maxPolyphony: 16, prewarm: 6 }), "you") };
    this.you.inst.output.connect(youChannel);
    this.transportTempo(opts.harmony.bpm);
  }

  // --- messages ----------------------------------------------------------

  /**
   * Stage a part version; it lands at the next loop line. Keys on content: a
   * part whose id was already staged is ignored, and an instrument is built only
   * when the sound changes. `preset` is required for pitched parts.
   */
  stage(track: TrackId, part: PartRef, preset: ClaudioPreset | null): void {
    const t = this.tracks[track];
    if (t.stagedId === part.id) return;
    t.stagedId = part.id;
    const currentSound = t.next?.sound ?? t.sound;
    if (!t.inst || part.sound !== currentSound) {
      if (t.next) t.next.inst.dispose();
      t.next = { sound: part.sound, inst: this.build(track, preset) };
    }
    this.mailbox.push({ kind: "part", track, part });
  }

  setHarmony(harmony: Harmony): void {
    this.mailbox.push({ kind: "harmony", harmony });
  }

  /** Steps until the track's staged part lands (the "lands in N" countdown). */
  landsIn(track: TrackId): number | null {
    const pending = this.mailbox.some((m) => m.kind === "part" && m.track === track);
    if (pending) return Math.max(0, nextLoopLine(this.seq) - (this.seq.lastG + 1));
    const t = this.seq.tracks[track];
    return t.staged && t.landsAtG !== null ? Math.max(0, t.landsAtG - (this.seq.lastG + 1)) : null;
  }

  lastG(): number {
    return this.seq.lastG;
  }

  get harmony(): Harmony {
    return this.seq.harmony;
  }

  /** Instant: the channel mutes now; the sequencer ignores mute. */
  setMuted(channel: ChannelId, muted: boolean): void {
    this.channelOf(channel).mute = muted;
  }

  setSolo(channel: ChannelId, solo: boolean): void {
    this.channelOf(channel).solo = solo;
  }

  // --- transport ---------------------------------------------------------

  start(time?: number): void {
    if (this.running) return;
    const transport = this.context.transport;
    if (this.repeatId === null) this.repeatId = transport.scheduleRepeat((t) => this.tick(t), "16n", 0);
    transport.start(time);
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    const now = this.context.now();
    this.context.transport.stop(now);
    for (const id of TRACKS) this.tracks[id].inst?.releaseAll(now);
    this.drainMailbox();
    this.seq = resetForStart(this.seq);
    this.running = false;
  }

  // --- your live channel -------------------------------------------------

  /** immediate(), not now(): now() includes the lookahead and would make you 150ms late. */
  liveAttack(midi: number, vel = 0.85): void {
    const inst = this.you.inst;
    this.held.get(midi)?.release(midi, this.context.immediate());
    this.held.set(midi, inst);
    inst.attack(midi, this.context.immediate(), vel);
  }

  /** Released on the synth that started the note, even after a sound swap. */
  liveRelease(midi: number): void {
    const inst = this.held.get(midi);
    if (!inst) return;
    this.held.delete(midi);
    inst.release(midi, this.context.immediate());
  }

  liveReleaseAll(): void {
    for (const midi of [...this.held.keys()]) this.liveRelease(midi);
  }

  // --- the tick ----------------------------------------------------------

  private tick(time: number): void {
    try {
      const g = Math.round(this.context.transport.getTicksAtTime(time) / STEP_TICKS);
      if (time < this.context.currentTime) this.missedSteps++;
      this.drainMailbox();
      const r = schedulerStep(this.seq, g);
      this.seq = r.state;
      this.g = g;

      for (const e of r.events) {
        if (e.type === "tempo") this.context.transport.bpm.setValueAtTime(e.bpm, time);
      }
      for (const p of r.promotions) {
        if (p.kind === "part") this.promote(p.track, p.part, time, g);
      }
      const stepSec = 60 / this.seq.harmony.bpm / 4;
      for (const e of r.events) {
        try {
          if (e.type === "hit") this.tracks[e.track].inst?.hit(e.voice as DrumVoice, time, e.vel);
          else if (e.type === "attack") this.tracks[e.track].inst?.attackRelease(e.midi, (e.durTicks / STEP_TICKS) * stepSec, time, e.vel);
        } catch (err) {
          console.error("[engine] event failed", e, err);
        }
      }
      const onStep = this.opts.onStep;
      if (onStep) this.context.draw.schedule(() => onStep(g), time);
    } catch (err) {
      console.error("[engine] tick failed", err);
    }
  }

  private drainMailbox(): void {
    for (const m of this.mailbox) {
      this.seq = m.kind === "part" ? seqStage(this.seq, m.track, m.part) : stageHarmony(this.seq, m.harmony);
    }
    this.mailbox = [];
  }

  private promote(track: TrackId, part: PartRef, time: number, g: number): void {
    const t = this.tracks[track];
    this.promotions.push({ g, track, id: part.id });
    if (t.next && t.next.sound === part.sound) {
      const old = t.inst;
      if (old) {
        old.releaseAll(time);
        const ms = (old.tail + 0.5 + Math.max(0, time - this.context.currentTime)) * 1000;
        setTimeout(() => old.dispose(), ms);
      }
      t.inst = t.next.inst;
      t.sound = t.next.sound;
      t.next = null;
    }
  }

  private build(track: TrackId, preset: ClaudioPreset | null): Instrument {
    const ctx = this.context;
    let inst: Instrument;
    if (track === "drums") inst = buildKit(this.kick, ctx);
    else if (!preset) throw new Error(`${track} needs a preset`);
    else if (track === "bass") inst = buildBass(preset, ctx);
    else inst = buildPoly(preset, ctx, { maxPolyphony: 24, maxRelease: KEYS_MAX_RELEASE, prewarm: 8 });
    inst.output.connect(this.tracks[track].channel);
    return this.wrap(inst, track);
  }

  private wrap(inst: Instrument, track: string): Instrument {
    return this.opts.spy ? spy(inst, track, this.calls, () => this.g) : inst;
  }

  private channelOf(id: ChannelId): Tone.Channel {
    return id === "you" ? this.you.channel : this.tracks[id].channel;
  }

  private transportTempo(bpm: number): void {
    this.context.transport.bpm.value = bpm;
  }
}

/** Decode the 808 kick on the given context. */
export async function loadKick(context: Tone.BaseContext = Tone.getContext()): Promise<AudioBuffer> {
  const url = new URL("../../../samples/kick_tr808.wav", import.meta.url).href;
  const bytes = await (await fetch(url)).arrayBuffer();
  return await context.decodeAudioData(bytes);
}
