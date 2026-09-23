import { describe, expect, test } from "vitest";

import {
  accentedVel,
  chordRootDegree,
  clampPattern,
  degreeToMidi,
  MAX_NOTES,
  summarizePattern,
  type DrumPattern,
  type PitchedPattern,
} from "./pattern";

const D = 2; // pitch class of D

describe("degreeToMidi", () => {
  test("tonic in C major, octave 4, is middle C", () => {
    expect(degreeToMidi(0, "major", 0, 4)).toBe(60);
  });

  test("walks the D natural minor scale", () => {
    const up = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => degreeToMidi(D, "minor", d, 4));
    // D E F G A Bb C D
    expect(up).toEqual([62, 64, 65, 67, 69, 70, 72, 74]);
  });

  test("negative degrees go below the tonic", () => {
    expect(degreeToMidi(D, "minor", -1, 4)).toBe(60); // C4
    expect(degreeToMidi(D, "minor", -7, 4)).toBe(50); // D3
    expect(degreeToMidi(D, "minor", -8, 4)).toBe(48); // C3
  });

  test("chord-relative degrees 0/2/4 are the chord tones", () => {
    // Bb is degree 5 of D minor: Bb D F.
    const root = 5;
    const tones = [0, 2, 4].map((d) => degreeToMidi(D, "minor", root + d, 3) % 12);
    expect(tones).toEqual([10, 2, 5]);
  });
});

describe("chordRootDegree", () => {
  test("wraps roots into -3..3 so parts stay near the tonic", () => {
    // Dm Bb F C in D minor, as scale degrees 0 5 2 6.
    const prog = [0, 5, 2, 6];
    expect([0, 1, 2, 3].map((bar) => chordRootDegree(prog, bar))).toEqual([0, -2, 2, -1]);
  });

  test("cycles when the loop is longer than the progression", () => {
    expect(chordRootDegree([0, 3], 3)).toBe(3);
  });

  test("an empty progression is the tonic", () => {
    expect(chordRootDegree([], 2)).toBe(0);
  });
});

describe("accentedVel", () => {
  test("accent adds 0.25", () => expect(accentedVel(0.5, true)).toBeCloseTo(0.75));
  test("accent clamps to 1", () => expect(accentedVel(0.9, true)).toBe(1));
  test("no accent leaves velocity alone", () => expect(accentedVel(0.5, false)).toBe(0.5));
});

describe("clampPattern: drums", () => {
  test("never throws on garbage; garbage is an empty 1-bar pattern", () => {
    for (const raw of [null, undefined, "x", 3, { notes: "x" }, { lengthBars: "big", notes: [null, 7] }]) {
      expect(clampPattern("drums", raw)).toEqual({ lengthBars: 1, notes: [] });
    }
  });

  test("lengthBars snaps up to 1, 2 or 4", () => {
    expect(clampPattern("drums", { lengthBars: 2, notes: [] }).lengthBars).toBe(2);
    expect(clampPattern("drums", { lengthBars: 3, notes: [] }).lengthBars).toBe(4);
    expect(clampPattern("drums", { lengthBars: 9, notes: [] }).lengthBars).toBe(4);
    expect(clampPattern("drums", { lengthBars: 0, notes: [] }).lengthBars).toBe(1);
  });

  test("drops hits outside the part, with bad voices, or with non-integer-able steps", () => {
    const p = clampPattern("drums", {
      lengthBars: 1,
      notes: [
        { step: 0, voice: "kick", vel: 0.9, accent: false },
        { step: 16, voice: "kick", vel: 0.9, accent: false },
        { step: -1, voice: "kick", vel: 0.9, accent: false },
        { step: 4, voice: "cowbell", vel: 0.9, accent: false },
        { step: "nope", voice: "snare", vel: 0.9, accent: false },
      ],
    });
    expect(p.notes.map((n) => [n.step, n.voice])).toEqual([[0, "kick"]]);
  });

  test("defaults and clamps velocity; coerces accent to boolean", () => {
    const p = clampPattern("drums", {
      lengthBars: 1,
      notes: [
        { step: 0, voice: "kick" },
        { step: 4, voice: "snare", vel: 7, accent: "yes" },
      ],
    });
    expect(p.notes[0]).toEqual({ step: 0, voice: "kick", vel: 0.8, accent: false });
    expect(p.notes[1]).toEqual({ step: 4, voice: "snare", vel: 1, accent: false });
  });

  test("dedupes a voice on a step, and keeps only one of hat/openhat per step", () => {
    const p = clampPattern("drums", {
      lengthBars: 1,
      notes: [
        { step: 2, voice: "hat", vel: 0.5, accent: false },
        { step: 2, voice: "hat", vel: 0.9, accent: false },
        { step: 2, voice: "openhat", vel: 0.9, accent: false },
        { step: 2, voice: "kick", vel: 0.9, accent: false },
      ],
    });
    expect(p.notes.map((n) => n.voice).sort()).toEqual(["hat", "kick"]);
    expect(p.notes.find((n) => n.voice === "hat")!.vel).toBe(0.5);
  });

  test("sorts by step", () => {
    const p = clampPattern("drums", {
      lengthBars: 1,
      notes: [
        { step: 8, voice: "kick", vel: 1, accent: false },
        { step: 0, voice: "kick", vel: 1, accent: false },
      ],
    });
    expect(p.notes.map((n) => n.step)).toEqual([0, 8]);
  });
});

describe("clampPattern: pitched", () => {
  const note = (step: number, deg = 0, extra: object = {}) => ({ step, deg, len: 1, vel: 0.8, accent: false, tie: false, ...extra });

  test("bass is monophonic: one note per step, first wins", () => {
    const p = clampPattern("bass", { lengthBars: 1, notes: [note(0, 0), note(0, 4)] });
    expect(p.notes).toEqual([note(0, 0)]);
  });

  test("keys allow four notes per step", () => {
    const p = clampPattern("keys", { lengthBars: 1, notes: [0, 1, 2, 3, 4, 5].map((d) => note(0, d)) });
    expect(p.notes.map((n) => n.deg)).toEqual([0, 1, 2, 3]);
  });

  test("dedupes the same degree on the same step", () => {
    const p = clampPattern("keys", { lengthBars: 1, notes: [note(0, 2), note(0, 2)] });
    expect(p.notes).toHaveLength(1);
  });

  test("caps the whole pattern at MAX_NOTES", () => {
    const notes = [];
    for (let step = 0; step < 64; step++) for (let d = 0; d < 5; d++) notes.push(note(step, d));
    const p = clampPattern("keys", { lengthBars: 4, notes });
    expect(p.notes).toHaveLength(MAX_NOTES);
  });

  test("ties are forced off in wave 1", () => {
    const p = clampPattern("bass", { lengthBars: 1, notes: [note(0, 0, { tie: true })] });
    expect(p.notes[0].tie).toBe(false);
  });

  test("rounds degree and step, clamps degree, len at least 1 and within the part", () => {
    const p = clampPattern("bass", {
      lengthBars: 1,
      notes: [note(0.4, 2.6, { len: 0 }), note(4, 99, { len: 40 }), note(8, -99, { len: 2.4 })],
    });
    expect(p.notes.map((n) => [n.step, n.deg, n.len])).toEqual([
      [0, 3, 1],
      [4, 14, 16],
      [8, -7, 2],
    ]);
  });

  test("an empty note list means lay out", () => {
    expect(clampPattern("bass", { lengthBars: 2, notes: [] })).toEqual({ lengthBars: 2, notes: [] });
  });
});

describe("summarizePattern", () => {
  test("drums: explicit step lists per voice, accents as X", () => {
    const p: DrumPattern = {
      lengthBars: 1,
      notes: [
        { step: 0, voice: "kick", vel: 1, accent: true },
        { step: 4, voice: "kick", vel: 1, accent: false },
        { step: 8, voice: "kick", vel: 1, accent: false },
        { step: 12, voice: "kick", vel: 1, accent: false },
        { step: 4, voice: "snare", vel: 1, accent: false },
        { step: 12, voice: "snare", vel: 1, accent: false },
      ],
    };
    expect(summarizePattern("drums", p)).toBe("1 bar · kick 0X,4,8,12 · snare 4,12");
  });

  test("pitched: step:degree, /len when longer than a step, X for accent", () => {
    const p: PitchedPattern = {
      lengthBars: 2,
      notes: [
        { step: 0, deg: 0, len: 1, vel: 1, accent: true, tie: false },
        { step: 4, deg: 4, len: 2, vel: 1, accent: false, tie: false },
        { step: 6, deg: -1, len: 1, vel: 1, accent: false, tie: true },
      ],
    };
    expect(summarizePattern("bass", p)).toBe("2 bars · 0:0X 4:4/2 6:-1~");
  });

  test("empty pattern says it lays out", () => {
    expect(summarizePattern("keys", { lengthBars: 1, notes: [] })).toBe("1 bar · lays out");
  });
});
