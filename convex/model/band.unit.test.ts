/**
 * Slice 5, unit layer: the band turn's pure pieces (plan §4, §5).
 */
import { describe, expect, test } from "vitest";

import { planCommit, type CommitInput } from "./commit";
import { toolsFor } from "./bandTools";
import { LLM } from "./llmConfig";
import { mergeAdjacentRoles } from "./messages";
import { buildSnapshot, type SnapshotInput } from "./snapshot";
import { DEFAULT_PRESET } from "../../src/shared/preset";

describe("toolsFor", () => {
  test("every role gets a fixed list; drums get no sound tools; every tool is strict with a say", () => {
    expect(toolsFor("drums").map((t) => t.name)).toEqual(["set_drum_pattern", "just_reply", "stay"]);
    expect(toolsFor("bass").map((t) => t.name)).toEqual(["set_pattern", "set_sound", "use_library_sound", "just_reply", "stay"]);
    for (const role of ["drums", "bass", "keys"] as const) {
      for (const t of toolsFor(role)) {
        expect(t.strict).toBe(true);
        expect((t.input_schema as { required: string[] }).required).toContain("say");
        expect(JSON.stringify(t.input_schema)).not.toMatch(/"(minimum|maximum)"/);
      }
    }
  });
});

describe("LLM config", () => {
  test("each kind's timeout is below its lease", () => {
    for (const kind of ["band", "design"] as const) expect(LLM[kind].timeoutMs).toBeLessThan(LLM[kind].leaseMs);
    expect(LLM.band).toMatchObject({ model: "claude-sonnet-5", timeoutMs: 30_000, leaseMs: 45_000 });
    expect(LLM.design).toMatchObject({ timeoutMs: 90_000, leaseMs: 150_000 });
  });
});

const current = {
  lengthBars: 1 as const,
  notes: [{ step: 0, deg: 0, len: 3, vel: 0.75, accent: true, tie: false }],
  soundName: "Monopoly Thump",
  preset: { ...DEFAULT_PRESET, name: "Monopoly Thump" },
};
const input = (calls: CommitInput["calls"], over: Partial<CommitInput> = {}): CommitInput => ({
  role: "bass",
  calls,
  current,
  library: [{ id: "lib-sub", name: "Juno Sub Round" }],
  ...over,
});
const eighths = { say: "Eighths on the root.", lengthBars: 1, notes: [0, 2, 4, 6, 8, 10, 12, 14].map((step) => ({ step, deg: 0, len: 1, vel: 0.8, accent: step % 8 === 0 })) };

describe("planCommit", () => {
  test("set_pattern: a clamped part, the say as the label, one ok result", () => {
    const p = planCommit(input([{ id: "t1", name: "set_pattern", input: eighths }]));
    expect(p.part?.notes).toHaveLength(8);
    expect(p.part?.lengthBars).toBe(1);
    expect(p.sound).toBeNull();
    expect(p.says).toEqual(["Eighths on the root."]);
    expect(p.results).toEqual([{ type: "tool_result", tool_use_id: "t1", content: expect.stringMatching(/next bar line/) }]);
    expect(p.errors).toEqual([]);
  });

  test("a two-call turn (pattern + sound) merges into one change, with both says, one result per call in order", () => {
    const p = planCommit(
      input([
        { id: "t1", name: "set_pattern", input: eighths },
        { id: "t2", name: "use_library_sound", input: { say: "And the Juno sub.", name: "juno sub round" } },
      ]),
    );
    expect(p.part?.notes).toHaveLength(8);
    expect(p.sound).toEqual({ kind: "library", libraryId: "lib-sub", name: "Juno Sub Round" });
    expect(p.says).toEqual(["Eighths on the root.", "And the Juno sub."]);
    expect(p.results.map((r) => r.tool_use_id)).toEqual(["t1", "t2"]);
  });

  test("set_sound: a clamped preset becomes a tweak", () => {
    const preset = { ...DEFAULT_PRESET, name: "Glassier EP", modulationIndex: 99 };
    const p = planCommit(input([{ id: "t1", name: "set_sound", input: { say: "More shimmer.", preset } }], { role: "keys" }));
    expect(p.sound).toMatchObject({ kind: "tweak", preset: { name: "Glassier EP", modulationIndex: 30 } });
  });

  test("invalid calls become is_error results and never throw; the reason is kept for the failure copy", () => {
    const p = planCommit(
      input([
        { id: "t1", name: "set_pattern", input: { say: "x", lengthBars: 2, notes: [{ step: 40, deg: 0, len: 1, vel: 1, accent: false }] } },
        { id: "t2", name: "use_library_sound", input: { say: "y", name: "Nope" } },
        { id: "t3", name: "set_drum_pattern", input: { say: "z", lengthBars: 1, hits: [] } },
        { id: "t4", name: "launch_rockets", input: {} },
      ]),
    );
    expect(p.part).toBeNull();
    expect(p.sound).toBeNull();
    expect(p.results.every((r) => r.is_error)).toBe(true);
    expect(p.errors[0]).toBe("step 40 is outside the 2-bar part");
    expect(p.errors).toHaveLength(4);
  });

  test("just_reply and stay change nothing", () => {
    const p = planCommit(input([{ id: "t1", name: "stay", input: { say: "Leaving it." } }]));
    expect(p).toMatchObject({ part: null, sound: null, says: ["Leaving it."], errors: [] });
  });

  test("drums: set_drum_pattern with at most one of hat/openhat per step", () => {
    const hits = [
      { step: 0, voice: "kick", vel: 1, accent: true },
      { step: 2, voice: "hat", vel: 0.6, accent: false },
      { step: 2, voice: "openhat", vel: 0.6, accent: false },
    ];
    const p = planCommit(input([{ id: "t1", name: "set_drum_pattern", input: { say: "Tighter.", lengthBars: 1, hits } }], { role: "drums" }));
    expect(p.part?.notes).toHaveLength(2);
  });
});

describe("mergeAdjacentRoles", () => {
  test("adjacent same-role messages merge into one, text becoming a block; nothing else changes", () => {
    const merged = mergeAdjacentRoles([
      { role: "user", content: "snapshot" },
      { role: "user", content: [{ type: "text", text: "[producer → @bass] busier" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] },
      { role: "user", content: "[the previous request failed; ignore it]" },
    ]);
    expect(merged).toEqual([
      { role: "user", content: [{ type: "text", text: "snapshot" }, { type: "text", text: "[producer → @bass] busier" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t", content: "done" },
          { type: "text", text: "[the previous request failed; ignore it]" },
        ],
      },
    ]);
  });
});

describe("buildSnapshot", () => {
  const base: SnapshotInput = {
    jam: { bpm: 96, keyPc: 2, scale: "minor", bars: 4, progression: [0, 5, 2, 6] },
    me: { role: "bass", partSummary: "1 bar · 0:0/3X", soundName: "Monopoly Thump", preset: null, versionLabel: "v4" },
    others: [
      { role: "drums", summary: "1 bar · kick 0X,8 · snare 4,12", soundName: "Kit", muted: false },
      { role: "keys", summary: "1 bar · 0:0/3 0:2/3 0:4/3", soundName: "Velvet Tine EP", muted: true },
    ],
    producer: { soundName: "Fat Square Pad", octave: 3 },
    library: ["Monopoly Thump", "Juno Sub Round"],
    rollback: null,
    scene: null,
  };

  test("has the harmony, every other part as step lists (muted marked), your part and sound, the producer and your library", () => {
    const s = buildSnapshot(base);
    expect(s).toContain("96 bpm");
    expect(s).toContain("D minor");
    expect(s).toContain("Dm, B♭, F, C");
    expect(s).toContain("drums: 1 bar · kick 0X,8 · snare 4,12");
    expect(s).toContain("keys (muted): 1 bar · 0:0/3 0:2/3 0:4/3");
    expect(s).toContain("Your part (bass, v4): 1 bar · 0:0/3X");
    expect(s).toContain("The producer is playing along live on Fat Square Pad, around octave 3");
    expect(s).toContain("Juno Sub Round");
  });

  test("the rollback note appears when the producer took you back", () => {
    const s = buildSnapshot({ ...base, rollback: { fromLabel: "v5", fromCaption: "Busier eighths", toLabel: "v3" } });
    expect(s).toContain("The producer took you back from v5 (Busier eighths) to v3; don't re-propose it unless asked.");
  });

  test("a scene note appears after a scene recall", () => {
    expect(buildSnapshot({ ...base, scene: "A" })).toContain("The producer recalled scene A");
  });

  test("with no producer note yet, the octave line says so", () => {
    expect(buildSnapshot({ ...base, producer: { soundName: "Fat Square Pad", octave: null } })).toContain("The producer is playing along live on Fat Square Pad");
  });
});
