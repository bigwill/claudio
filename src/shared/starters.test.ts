/**
 * Slice 2: the starter library and starter parts are data every jam begins
 * with, so they must already be in range and already clamped: nothing in them
 * may be silently rewritten when a jam is created or a part is staged.
 */
import { describe, expect, test } from "vitest";

import { clampPattern, summarizePattern } from "./pattern";
import { clampPreset } from "./preset";
import { STARTER_PARTS, STARTER_SOUNDS, DEFAULT_SOUNDS } from "./starters";

describe("starter sounds", () => {
  test("there is more than one bass and more than one keys sound to pick from", () => {
    expect(STARTER_SOUNDS.filter((s) => s.role === "bass").length).toBeGreaterThanOrEqual(2);
    expect(STARTER_SOUNDS.filter((s) => s.role === "keys").length).toBeGreaterThanOrEqual(2);
  });

  test("starterKeys are unique; names are real patch names", () => {
    const keys = STARTER_SOUNDS.map((s) => s.starterKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of STARTER_SOUNDS) {
      expect(s.name.length).toBeGreaterThan(2);
      expect(s.name).toBe(s.preset.name);
    }
  });

  test("every preset is already in range (clampPreset changes nothing)", () => {
    for (const s of STARTER_SOUNDS) expect(clampPreset(s.preset)).toEqual(s.preset);
  });

  test("each records where it came from: the WAV it was designed from", () => {
    for (const s of STARTER_SOUNDS) expect(s.source).toMatch(/\.wav$/);
  });

  test("the default sounds for bass, keys and you exist, with the right roles", () => {
    const byKey = new Map(STARTER_SOUNDS.map((s) => [s.starterKey, s]));
    expect(byKey.get(DEFAULT_SOUNDS.bass)?.role).toBe("bass");
    expect(byKey.get(DEFAULT_SOUNDS.keys)?.role).toBe("keys");
    expect(byKey.get(DEFAULT_SOUNDS.you)).toBeDefined();
  });
});

describe("starter parts", () => {
  test("drums, bass and keys each have a part that clampPattern leaves unchanged", () => {
    expect(clampPattern("drums", STARTER_PARTS.drums)).toEqual(STARTER_PARTS.drums);
    expect(clampPattern("bass", STARTER_PARTS.bass)).toEqual(STARTER_PARTS.bass);
    expect(clampPattern("keys", STARTER_PARTS.keys)).toEqual(STARTER_PARTS.keys);
  });

  test("none of them lays out", () => {
    for (const role of ["drums", "bass", "keys"] as const) {
      expect(summarizePattern(role, STARTER_PARTS[role])).not.toContain("lays out");
    }
  });
});
