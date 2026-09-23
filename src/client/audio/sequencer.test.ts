import { describe, expect, test } from "vitest";

import type { DrumPattern, PitchedPattern } from "../../shared/pattern";
import {
  initialState,
  resetForStart,
  schedulerStep,
  stage,
  stageHarmony,
  stepsUntilLanding,
  STEP_TICKS,
  type Harmony,
  type PartRef,
  type SeqEvent,
  type SeqState,
  type StepResult,
} from "./sequencer";

const H: Harmony = { bpm: 120, keyPc: 2, scale: "minor", progression: [0, 5, 2, 6], bars: 1 };

const fourOnFloor: DrumPattern = {
  lengthBars: 1,
  notes: [0, 4, 8, 12].map((step) => ({ step, voice: "kick" as const, vel: 0.8, accent: step === 0 })),
};
const bassRoot: PitchedPattern = {
  lengthBars: 1,
  notes: [{ step: 0, deg: 0, len: 2, vel: 0.8, accent: false, tie: false }],
};
const keysChord: PitchedPattern = {
  lengthBars: 1,
  notes: [0, 2, 4].map((deg) => ({ step: 0, deg, len: 4, vel: 0.6, accent: false, tie: false })),
};

const drums = (id = "d1"): PartRef => ({ id, sound: null, role: "drums", pattern: fourOnFloor });
const bass = (id = "b1", pattern: PitchedPattern = bassRoot, sound = "rubber"): PartRef => ({ id, sound, role: "bass", pattern });
const keys = (id = "k1"): PartRef => ({ id, sound: "ep", role: "keys", pattern: keysChord });

/** Run steps from..to inclusive, collecting every result by g. */
function run(state: SeqState, from: number, to: number): { state: SeqState; byG: Map<number, StepResult> } {
  const byG = new Map<number, StepResult>();
  for (let g = from; g <= to; g++) {
    const r = schedulerStep(state, g);
    byG.set(g, r);
    state = r.state;
  }
  return { state, byG };
}

const events = (r: StepResult | undefined, type: SeqEvent["type"]) => (r?.events ?? []).filter((e) => e.type === type);

describe("starting", () => {
  test("parts staged before the first step all promote at g=0", () => {
    let s = initialState(H);
    s = stage(s, "drums", drums());
    s = stage(s, "bass", bass());
    s = stage(s, "keys", keys());
    const r = schedulerStep(s, 0);
    expect(r.promotions.map((p) => p.kind === "part" && p.track).sort()).toEqual(["bass", "drums", "keys"]);
    expect(events(r, "hit")).toHaveLength(1);
    expect(events(r, "attack")).toHaveLength(4);
  });

  test("resetForStart re-stages the current parts so a restart promotes at g=0 again", () => {
    let s = stage(initialState(H), "drums", drums());
    s = run(s, 0, 9).state;
    s = resetForStart(s);
    expect(s.tracks.drums.current).toBeNull();
    const r = schedulerStep(s, 0);
    expect(r.promotions).toHaveLength(1);
    expect(events(r, "hit")).toHaveLength(1);
  });
});

describe("repeats and pitch", () => {
  test("a 1-bar drum part repeats every bar, accent folded into velocity", () => {
    const s = stage(initialState({ ...H, bars: 2 }), "drums", drums());
    const { byG } = run(s, 0, 31);
    const hitGs = [...byG].filter(([, r]) => events(r, "hit").length).map(([g]) => g);
    expect(hitGs).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    expect(events(byG.get(0), "hit")[0]).toMatchObject({ track: "drums", voice: "kick", vel: 1 });
    expect(events(byG.get(4), "hit")[0]).toMatchObject({ vel: 0.8 });
  });

  test("a 1-bar bass part follows the chords bar by bar", () => {
    const s = stage(initialState({ ...H, bars: 4 }), "bass", bass());
    const { byG } = run(s, 0, 63);
    const midis = [0, 16, 32, 48].map((g) => (events(byG.get(g), "attack")[0] as { midi: number }).midi);
    // D2, Bb1, F2, C2: Dm Bb F C with roots wrapped near the tonic, bass octave 2.
    expect(midis).toEqual([38, 34, 41, 36]);
  });

  test("keys voice the chord at octave 4, with durations in ticks", () => {
    const s = stage(initialState(H), "keys", keys());
    const r = schedulerStep(s, 0);
    const attacks = events(r, "attack") as Array<{ midi: number; durTicks: number; vel: number }>;
    expect(attacks.map((a) => a.midi)).toEqual([62, 65, 69]); // D4 F4 A4
    expect(attacks.every((a) => a.durTicks === 4 * STEP_TICKS)).toBe(true);
  });

  test("a 2-bar part in a 4-bar loop plays both of its bars, twice", () => {
    const twoBar: PitchedPattern = {
      lengthBars: 2,
      notes: [{ step: 20, deg: 0, len: 1, vel: 0.8, accent: false, tie: false }],
    };
    const s = stage(initialState({ ...H, bars: 4 }), "bass", bass("b1", twoBar));
    const { byG } = run(s, 0, 63);
    const gs = [...byG].filter(([, r]) => events(r, "attack").length).map(([g]) => g);
    expect(gs).toEqual([20, 52]);
  });
});

describe("staging and promotion", () => {
  test("landsAtG is the next loop line, and the countdown matches the actual landing", () => {
    let s = stage(initialState(H), "bass", bass("b1"));
    s = run(s, 0, 5).state;
    s = stage(s, "bass", bass("b2"));
    expect(s.tracks.bass.landsAtG).toBe(16);
    const countdown = stepsUntilLanding(s, "bass")!;
    expect(countdown).toBe(10);
    const { byG } = run(s, 6, 20);
    const promotedAt = [...byG].filter(([, r]) => r.promotions.length).map(([g]) => g);
    expect(promotedAt).toEqual([6 + countdown]);
  });

  test("changes staged at different times in one loop all promote on the same step", () => {
    let s = initialState({ ...H, bars: 2 });
    s = stage(s, "drums", drums("d1"));
    s = stage(s, "bass", bass("b1"));
    s = stage(s, "keys", keys("k1"));
    s = run(s, 0, 2).state;
    s = stage(s, "drums", drums("d2"));
    s = run(s, 3, 14).state;
    s = stage(s, "bass", bass("b2"));
    s = run(s, 15, 29).state;
    s = stage(s, "keys", keys("k2"));
    const { byG } = run(s, 30, 40);
    const promo = [...byG].filter(([, r]) => r.promotions.length);
    expect(promo.map(([g]) => g)).toEqual([32]);
    expect(promo[0][1].promotions).toHaveLength(3);
  });

  test("a staged part plays nothing until it lands; the old part keeps playing", () => {
    let s = stage(initialState({ ...H, bars: 2 }), "bass", bass("b1"));
    s = run(s, 0, 3).state;
    const moved: PitchedPattern = { lengthBars: 1, notes: [{ ...bassRoot.notes[0], step: 8 }] };
    s = stage(s, "bass", bass("b2", moved));
    const { byG } = run(s, 4, 47);
    // b1 still plays bar 2 (g=16); b2 lands at the line (g=32) and plays its step 8.
    expect([...byG].filter(([, r]) => events(r, "attack").length).map(([g]) => g)).toEqual([16, 40]);
  });

  test("the promotion carries the new sound so the engine can swap instruments", () => {
    let s = stage(initialState(H), "bass", bass("b1", bassRoot, "rubber"));
    s = run(s, 0, 7).state;
    s = stage(s, "bass", bass("b2", bassRoot, "glass"));
    const r = run(s, 8, 16).byG.get(16)!;
    expect(r.promotions).toEqual([{ kind: "part", track: "bass", part: expect.objectContaining({ id: "b2", sound: "glass" }) }]);
  });

  test("restaging before the line replaces the staged part", () => {
    let s = stage(initialState(H), "bass", bass("b1"));
    s = run(s, 0, 3).state;
    s = stage(s, "bass", bass("b2"));
    s = stage(s, "bass", bass("b3"));
    const r = run(s, 4, 16).byG.get(16)!;
    expect(r.promotions).toHaveLength(1);
    expect(r.state.tracks.bass.current!.id).toBe("b3");
  });

  test("a late tick still promotes, on the first step at or after the line", () => {
    let s = stage(initialState(H), "bass", bass("b1"));
    s = run(s, 0, 14).state;
    s = stage(s, "bass", bass("b2"));
    const r = schedulerStep(s, 17); // 15 and 16 were missed
    expect(r.promotions).toHaveLength(1);
  });

  test("an empty pattern lays out", () => {
    const s = stage(initialState(H), "bass", bass("b1", { lengthBars: 1, notes: [] }));
    const { byG } = run(s, 0, 15);
    expect([...byG.values()].flatMap((r) => r.events)).toEqual([]);
  });
});

describe("harmony changes", () => {
  test("a tempo change lands at the loop line and is the first event of that step", () => {
    let s = stage(initialState(H), "drums", drums());
    s = run(s, 0, 4).state;
    s = stageHarmony(s, { ...H, bpm: 140 });
    const { byG } = run(s, 5, 16);
    expect(events(byG.get(15), "tempo")).toHaveLength(0);
    const at16 = byG.get(16)!;
    expect(at16.events[0]).toEqual({ type: "tempo", bpm: 140 });
    expect(at16.state.harmony.bpm).toBe(140);
  });

  test("a key change lands at the loop line", () => {
    let s = stage(initialState(H), "bass", bass());
    s = run(s, 0, 4).state;
    s = stageHarmony(s, { ...H, keyPc: 0, scale: "major" });
    const { byG } = run(s, 5, 16);
    expect((events(byG.get(16), "attack")[0] as { midi: number }).midi).toBe(36); // C2
  });

  test("a bar-count change resets the loop origin to the line it lands on", () => {
    let s = stage(initialState(H), "bass", bass());
    s = run(s, 0, 3).state;
    s = stageHarmony(s, { ...H, bars: 2 });
    const { state, byG } = run(s, 4, 48);
    expect(state.g0).toBe(16);
    // g=16 is s=0 (chord 0: D2); g=32 is s=16 (chord 1: Bb1); g=48 is s=0 again.
    const midi = (g: number) => (events(byG.get(g), "attack")[0] as { midi: number }).midi;
    expect([midi(16), midi(32), midi(48)]).toEqual([38, 34, 38]);
  });

  test("the countdown uses the old loop length until the new one lands", () => {
    let s = stage(initialState({ ...H, bars: 2 }), "bass", bass());
    s = run(s, 0, 3).state;
    s = stageHarmony(s, { ...H, bars: 1 });
    s = stage(s, "bass", bass("b2"));
    expect(s.tracks.bass.landsAtG).toBe(32);
    expect(s.harmonyLandsAtG).toBe(32);
  });
});
