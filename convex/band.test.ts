/// <reference types="vite/client" />
/**
 * Slice 3 rails, convex-test layer: S1 (create), S6 (scenes), S10a (history and
 * picks; the turn-dependent cases land in slice 5).
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { DEFAULT_SOUNDS, STARTER_PARTS, STARTER_SOUNDS, starterSound } from "../src/shared/starters";

const nameOf = (key: string) => starterSound(key).name;

const modules = import.meta.glob("./**/*.ts");

async function newJam(slug = "JAMTEST00001") {
  const t = convexTest(schema, modules);
  await t.mutation(api.jams.create, { slug });
  const state = (await t.query(api.jams.state, { slug }))!;
  const by = (role: string) => state.musicians.find((m) => m.role === role)!;
  return { t, slug, state, jamId: state.jam._id, you: by("producer"), drums: by("drums"), bass: by("bass"), keys: by("keys") };
}

const stateOf = async (t: ReturnType<typeof convexTest>, slug: string) => (await t.query(api.jams.state, { slug }))!;
const partOf = async (t: ReturnType<typeof convexTest>, slug: string, id: Id<"musicians">) =>
  (await stateOf(t, slug)).musicians.find((m) => m._id === id)!.part;

async function libraryId(t: ReturnType<typeof convexTest>, starterKey: string): Promise<Id<"library">> {
  const rows = await t.query(api.library.list, { role: "pitched" });
  return rows.find((r) => r.starterKey === starterKey)!._id;
}

describe("S1: create a jam", () => {
  test("soundcheck phase, 4 strips, starter parts and sounds, starters seeded", async () => {
    const { t, state, you, drums, bass, keys } = await newJam();
    expect(state.jam.phase).toBe("soundcheck");
    expect(state.musicians.map((m) => m.role).sort()).toEqual(["bass", "drums", "keys", "producer"]);
    expect(you.kind).toBe("human");
    expect(you.name).toBe("you");
    for (const m of [drums, bass, keys]) expect(m.kind).toBe("agent");

    expect(drums.part).toMatchObject({ version: 1, basedOn: 1, source: "starter", notes: STARTER_PARTS.drums.notes, sound: null });
    expect(bass.part).toMatchObject({ source: "starter", notes: STARTER_PARTS.bass.notes });
    expect(bass.part.sound?.name).toBe(nameOf(DEFAULT_SOUNDS.bass));
    expect(keys.part.sound?.name).toBe(nameOf(DEFAULT_SOUNDS.keys));
    expect(you.part.sound?.name).toBe(nameOf(DEFAULT_SOUNDS.you));
    expect(you.part.notes).toEqual([]);

    const lib = await t.query(api.library.list, { role: "pitched" });
    expect(lib.filter((r) => r.origin === "starter").map((r) => r.starterKey).sort()).toEqual(
      STARTER_SOUNDS.map((s) => s.starterKey).sort(),
    );
    expect(lib.every((r) => r.source.endsWith(".wav"))).toBe(true);
  });

  test("create is idempotent, and a second jam doesn't duplicate the starters", async () => {
    const { t, slug } = await newJam();
    await t.mutation(api.jams.create, { slug });
    expect((await stateOf(t, slug)).musicians).toHaveLength(4);
    await t.mutation(api.jams.create, { slug: "JAMTEST00002" });
    const lib = await t.query(api.library.list, { role: "pitched" });
    expect(lib.filter((r) => r.origin === "starter")).toHaveLength(STARTER_SOUNDS.length);
  });

  test("library.list filters by role, newest first", async () => {
    const { t } = await newJam();
    const bass = await t.query(api.library.list, { role: "bass" });
    expect(bass.every((r) => r.role === "bass")).toBe(true);
    expect(bass.length).toBeGreaterThanOrEqual(2);
  });
});

describe("S10a: history and picks", () => {
  test("the canonical walk: v1–v4, ← ← → v2, → → v3, a pick adds v5, ← → v4; rail labels", async () => {
    const { t, slug, bass } = await newJam();
    const reso = await libraryId(t, "bass-reso");
    const sub = await libraryId(t, "bass-sub");
    for (const lib of [sub, reso, sub]) await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: lib }); // v2..v4
    const back = { kind: "step" as const, dir: -1 as const };
    await t.mutation(api.parts.history, { musicianId: bass._id, move: back });
    await t.mutation(api.parts.history, { musicianId: bass._id, move: back });
    expect((await partOf(t, slug, bass._id)).basedOn).toBe(2);
    await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "step", dir: 1 } });
    expect((await partOf(t, slug, bass._id)).basedOn).toBe(3);
    await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: sub }); // v3 plays reso; a new prompt/pick adds v5
    const rail = await t.query(api.parts.rail, { musicianId: bass._id });
    expect(rail.map((p) => p.label)).toEqual(["v1", "v2", "v3", "v4", "v5"]);
    await t.mutation(api.parts.history, { musicianId: bass._id, move: back });
    const now = await partOf(t, slug, bass._id);
    expect(now.basedOn).toBe(rail[3].basedOn);
    expect(now.source).toBe("history");
  });

  test("picking the sound the strip already plays writes nothing", async () => {
    const { t, bass } = await newJam();
    await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: await libraryId(t, "bass-reso") });
    expect(await t.query(api.parts.rail, { musicianId: bass._id })).toHaveLength(1);
  });

  test("a history step copies the target's notes and sound", async () => {
    const { t, slug, bass } = await newJam();
    await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: await libraryId(t, "bass-sub") });
    expect((await partOf(t, slug, bass._id)).sound?.name).toBe(nameOf("bass-sub"));
    await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "step", dir: -1 } });
    const p = await partOf(t, slug, bass._id);
    expect(p.sound?.name).toBe(nameOf(DEFAULT_SOUNDS.bass));
    expect(p.notes).toEqual(STARTER_PARTS.bass.notes);
  });

  test("no row is written at either end, or for a jump to where the strip already is", async () => {
    const { t, bass } = await newJam();
    const count = async () => (await t.query(api.parts.rail, { musicianId: bass._id })).length;
    const r1 = await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "step", dir: -1 } });
    const r2 = await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "newest" } });
    expect([r1, r2]).toEqual([{ moved: false }, { moved: false }]);
    expect(await count()).toBe(1);
  });

  test("a jump to a copy resolves to its basedOn", async () => {
    const { t, slug, bass } = await newJam();
    await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: await libraryId(t, "bass-sub") }); // v2 (row 2)
    await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "step", dir: -1 } }); // row 3 = copy of 1
    await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "newest" } }); // row 4 = copy of 2
    await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "jump", version: 3 } });
    expect((await partOf(t, slug, bass._id)).basedOn).toBe(1);
  });

  test("mute writes no part", async () => {
    const { t, slug, keys } = await newJam();
    await t.mutation(api.musicians.setMuted, { musicianId: keys._id, muted: true });
    const s = await stateOf(t, slug);
    const k = s.musicians.find((m) => m._id === keys._id)!;
    expect(k.muted).toBe(true);
    expect(k.part.version).toBe(1);
  });

  test("a history step on a thinking musician discards its turn (turnSeq bumps, idle)", async () => {
    const { t, slug, bass } = await newJam();
    await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: await libraryId(t, "bass-sub") });
    await t.run(async (ctx) => ctx.db.patch(bass._id, { status: "thinking", turnSeq: 5, turnDeadline: Date.now() + 30_000 }));
    await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "step", dir: -1 } });
    const m = (await t.run((ctx) => ctx.db.get(bass._id)))!;
    expect(m.status).toBe("idle");
    expect(m.turnSeq).toBe(6);
    expect((await partOf(t, slug, bass._id)).basedOn).toBe(1);
  });

  test("history and picks are refused for a musician that is designing; drums can't pick", async () => {
    const { t, bass, drums } = await newJam();
    const designId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("designs", fakeDesign(bass._id));
      await ctx.db.patch(bass._id, { activeDesignId: id });
      return id;
    });
    expect(designId).toBeTruthy();
    await expect(t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "oldest" } })).rejects.toThrow(/design/);
    await expect(
      t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: await libraryId(t, "bass-sub") }),
    ).rejects.toThrow(/design/);
    await expect(
      t.mutation(api.parts.pick, { musicianId: drums._id, libraryId: await libraryId(t, "bass-sub") }),
    ).rejects.toThrow(/kit/);
  });
});

describe("S6: scenes", () => {
  test("save A → change → save B → recall A: parts and mute return, A reads active, and stays so on re-query", async () => {
    const { t, slug, jamId, bass, keys } = await newJam();
    await t.mutation(api.jams.saveScene, { jamId, scene: "A" });
    expect((await stateOf(t, slug)).jam.activeScene).toBe("A");

    await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: await libraryId(t, "bass-sub") });
    await t.mutation(api.musicians.setMuted, { musicianId: keys._id, muted: true });
    expect((await stateOf(t, slug)).jam.activeScene).toBeNull();
    await t.mutation(api.jams.saveScene, { jamId, scene: "B" });
    expect((await stateOf(t, slug)).jam.activeScene).toBe("B");

    await t.mutation(api.jams.recallScene, { jamId, scene: "A" });
    const s = await stateOf(t, slug);
    const b = s.musicians.find((m) => m._id === bass._id)!;
    const k = s.musicians.find((m) => m._id === keys._id)!;
    expect(b.part.basedOn).toBe(1);
    expect(b.part.source).toBe("scene");
    expect(k.muted).toBe(false);
    expect(s.jam.activeScene).toBe("A");
    // "After a reload": a fresh query reads the same.
    expect((await stateOf(t, slug)).jam.activeScene).toBe("A");
    // Recalling B brings back the sub bass and the keys mute.
    await t.mutation(api.jams.recallScene, { jamId, scene: "B" });
    const s2 = await stateOf(t, slug);
    expect(s2.musicians.find((m) => m._id === bass._id)!.part.sound?.name).toBe(nameOf("bass-sub"));
    expect(s2.musicians.find((m) => m._id === keys._id)!.muted).toBe(true);
  });

  test("recall writes rows only for strips that differ, all in one txn", async () => {
    const { t, jamId, bass } = await newJam();
    await t.mutation(api.jams.saveScene, { jamId, scene: "A" });
    await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: await libraryId(t, "bass-sub") });
    await t.mutation(api.jams.recallScene, { jamId, scene: "A" });
    const rows = await t.run((ctx) => ctx.db.query("parts").collect());
    const scene = rows.filter((r) => r.source === "scene");
    expect(scene).toHaveLength(1);
    expect(scene[0].prev).toBe(2);
    expect(scene[0].prevMuted).toBe(false);
  });

  test("recall of an unsaved scene, or while a design runs, is refused", async () => {
    const { t, jamId, keys } = await newJam();
    await expect(t.mutation(api.jams.recallScene, { jamId, scene: "B" })).rejects.toThrow(/saved/);
    await t.mutation(api.jams.saveScene, { jamId, scene: "A" });
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("designs", fakeDesign(keys._id));
      await ctx.db.patch(keys._id, { activeDesignId: id });
    });
    await expect(t.mutation(api.jams.recallScene, { jamId, scene: "A" })).rejects.toThrow(/design/);
  });
});

describe("start", () => {
  test("switches to the jam phase; refused while a design runs", async () => {
    const { t, slug, jamId, keys } = await newJam();
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("designs", fakeDesign(keys._id));
      await ctx.db.patch(keys._id, { activeDesignId: id });
    });
    await expect(t.mutation(api.jams.start, { jamId })).rejects.toThrow(/design/);
    await t.run((ctx) => ctx.db.patch(keys._id, { activeDesignId: null }));
    await t.mutation(api.jams.start, { jamId });
    expect((await stateOf(t, slug)).jam.phase).toBe("jam");
  });
});

describe("chat.send", () => {
  test("posts a producer row addressed by @mention, with your octave; seq from the counters", async () => {
    const { t, jamId, bass } = await newJam();
    await t.mutation(api.chat.send, { jamId, text: "@bass busier, eighth notes", octave: 4 });
    await t.mutation(api.chat.send, { jamId, text: "everyone lay back", octave: 3 });
    const rows = await t.query(api.jams.chat, { jamId });
    expect(rows.map((r) => [r.seq, r.kind, r.to, r.octave])).toEqual([
      [2, "producer", [], 3],
      [1, "producer", [bass._id], 4],
    ]);
    const counters = await t.run((ctx) => ctx.db.query("jamCounters").first());
    expect(counters).toMatchObject({ chatSeq: 2, lastProducerSeq: 2, reactionBudget: 0 });
  });

  test("a note to one musician grants a reaction budget of 1; to several or @all, 0", async () => {
    const { t, jamId } = await newJam();
    await t.mutation(api.chat.send, { jamId, text: "@keys glassier", octave: 4 });
    expect((await t.run((ctx) => ctx.db.query("jamCounters").first()))!.reactionBudget).toBe(1);
    await t.mutation(api.chat.send, { jamId, text: "@bass @keys tighter", octave: 4 });
    expect((await t.run((ctx) => ctx.db.query("jamCounters").first()))!.reactionBudget).toBe(0);
  });
});

function fakeDesign(musicianId: Id<"musicians">) {
  return {
    musicianId,
    status: "thinking" as const,
    origin: "wav" as const,
    target: null,
    targetInfo: null,
    targetAudioId: null,
    prompt: null,
    renderSpec: null,
    iteration: 0,
    pendingToolUseId: null,
    pendingPresetId: null,
    renderOwnerClientId: null,
    renderLeaseUntil: 0,
    renderAttemptNo: 0,
    turnSeq: 0,
    turnDeadline: 0,
    noToolStrikes: 0,
    lastError: null,
  };
}
