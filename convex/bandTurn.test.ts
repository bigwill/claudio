/// <reference types="vite/client" />
/**
 * Slice 5 rails, convex-test layer: S4, S5, S9a, S9b and the turn half of S10a.
 * Fake LLM (CLAUDIO_FAKE_LLM=1) with fake timers; `settle()` runs what's due now.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { summarizePattern, type Pattern } from "../src/shared/pattern";

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CLAUDIO_FAKE_LLM", "1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const newT = () => convexTest(schema, modules);
type T = ReturnType<typeof newT>;
const SLUG = "BANDTURN0001";

async function settle(t: T, ms = 1) {
  vi.advanceTimersByTime(ms);
  await t.finishInProgressScheduledFunctions();
}

async function setup() {
  const t = newT();
  await t.mutation(api.jams.create, { slug: SLUG });
  const s = (await t.query(api.jams.state, { slug: SLUG }))!;
  const by = (role: string) => s.musicians.find((m) => m.role === role)!;
  return { t, jamId: s.jam._id, bass: by("bass"), keys: by("keys"), drums: by("drums") };
}

const musician = (t: T, id: Id<"musicians">) => t.run((ctx) => ctx.db.get(id)).then((m) => m!);
const strip = async (t: T, id: Id<"musicians">) => (await t.query(api.jams.state, { slug: SLUG }))!.musicians.find((m) => m._id === id)!;
const chat = (t: T, jamId: Id<"jams">) => t.query(api.jams.chat, { jamId }).then((rows) => [...rows].reverse());
const log = (t: T, id: Id<"musicians">) =>
  t.run((ctx) => ctx.db.query("messages").withIndex("by_convo_seq", (q) => q.eq("convoId", id)).collect()).then((rows) =>
    rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) as unknown })),
  );
const script = (t: T, match: string, turnIndex: number, response: unknown) => t.mutation(api.testing.setScript, { match, turnIndex, response });

describe("S4: \"@bass busier\"", () => {
  test("thinking → a threaded reply → bass plays a new agent version with accents; idle again", async () => {
    const { t, jamId, bass } = await setup();
    const noteSeq = await t.mutation(api.chat.send, { jamId, text: "@bass busier, eighth notes", octave: 3 });
    expect((await musician(t, bass._id)).status).toBe("thinking");
    await settle(t);
    const m = await musician(t, bass._id);
    expect(m.status).toBe("idle");
    const s = await strip(t, bass._id);
    expect(s.part.source).toBe("agent");
    expect(s.part.version).toBe(2);
    expect(summarizePattern("bass", { lengthBars: s.part.lengthBars, notes: s.part.notes } as Pattern)).toContain("X");
    const rows = await chat(t, jamId);
    const reply = rows.find((r) => r.kind === "musician")!;
    expect(reply).toMatchObject({ fromMusicianId: bass._id, replyToSeq: noteSeq });
    expect(reply.text.length).toBeGreaterThan(0);
  });

  test("the turn was sent the snapshot, the note and the tools; the log answers every tool_use", async () => {
    const { t, jamId, bass } = await setup();
    await t.mutation(api.chat.send, { jamId, text: "@bass busier, eighth notes", octave: 3 });
    await settle(t);
    const l = await log(t, bass._id);
    expect(l.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    const first = JSON.stringify(l[0].content);
    expect(first).toContain("[band snapshot]");
    expect(first).toContain("busier, eighth notes");
    const uses = (l[1].content as Array<{ type: string; id?: string }>).filter((b) => b.type === "tool_use");
    const results = (l[2].content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === "tool_result");
    expect(results.map((r) => r.tool_use_id)).toEqual(uses.map((u) => u.id));
  });
});

describe("S5: \"@keys glassier\"", () => {
  test("a tweak joins the library and becomes keys' sound; ← restores the previous sound", async () => {
    const { t, jamId, keys } = await setup();
    const before = (await strip(t, keys._id)).part;
    await t.mutation(api.chat.send, { jamId, text: "@keys make it glassier", octave: 4 });
    await settle(t);
    const after = (await strip(t, keys._id)).part;
    expect(after.libraryId).not.toBe(before.libraryId);
    const lib = await t.query(api.library.list, { role: "keys" });
    const tweak = lib.find((r) => r._id === after.libraryId)!;
    expect(tweak).toMatchObject({ origin: "tweak", source: `tweak of ${before.sound!.name}` });
    await t.mutation(api.parts.history, { musicianId: keys._id, move: { kind: "step", dir: -1 } });
    const back = (await strip(t, keys._id)).part;
    expect(back.libraryId).toBe(before.libraryId);
    expect(back.source).toBe("history");
  });
});

describe("S9a: robustness", () => {
  test("an invalid tool call → is_error, idle, a system row with the reason; the next note works", async () => {
    const { t, jamId, bass } = await setup();
    await script(t, "bass", 0, {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_bad", name: "set_pattern", input: { say: "Here.", lengthBars: 2, notes: [{ step: 40, deg: 0, len: 1, vel: 1, accent: false }] } }],
    });
    await t.mutation(api.chat.send, { jamId, text: "@bass busier", octave: 3 });
    await settle(t);
    expect((await musician(t, bass._id)).status).toBe("idle");
    expect((await strip(t, bass._id)).part.version).toBe(1);
    const l = await log(t, bass._id);
    expect(l[2].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_bad", content: "step 40 is outside the 2-bar part", is_error: true }]);
    expect((await chat(t, jamId)).map((r) => r.text)).toContain("bass's change didn't validate (step 40 is outside the 2-bar part). Still on v1.");

    await t.mutation(api.chat.send, { jamId, text: "@bass busier", octave: 3 });
    await settle(t);
    expect((await strip(t, bass._id)).part.version).toBe(2);
  });

  test("a turn past BAND_TIMEOUT_MS → idle with the \"didn't answer\" row; the failed request is marked to be ignored", async () => {
    const { t, jamId, bass } = await setup();
    // Real timers: the scripted 2s delay runs through the real abort timer,
    // shortened to 50ms for the test (the unit test pins the real 30s < 45s lease).
    vi.useRealTimers();
    await script(t, "bass", 0, { delay: 2_000, timeoutMs: 50 });
    await t.mutation(api.chat.send, { jamId, text: "@bass busier", octave: 3 });
    expect((await musician(t, bass._id)).status).toBe("thinking");
    await t.finishAllScheduledFunctions(() => {});
    expect((await musician(t, bass._id)).status).toBe("idle");
    expect((await chat(t, jamId)).map((r) => r.text)).toContain("bass didn't answer in time. Still on v1.");
    const l = await log(t, bass._id);
    expect(JSON.stringify(l.at(-1)!.content)).toContain("[the previous request failed; ignore it]");

    // Scripts key on assistant turns; the timed-out turn saved none, so clear it.
    await t.mutation(api.testing.clearScripts, {});
    await t.mutation(api.chat.send, { jamId, text: "@bass busier", octave: 3 });
    await t.finishAllScheduledFunctions(() => {});
    expect((await strip(t, bass._id)).part.version).toBe(2);
  });

  test("a refusal saves nothing and says so", async () => {
    const { t, jamId, bass } = await setup();
    await script(t, "bass", 0, { stop_reason: "refusal", content: [] });
    await t.mutation(api.chat.send, { jamId, text: "@bass busier", octave: 3 });
    await settle(t);
    expect((await musician(t, bass._id)).status).toBe("idle");
    expect((await log(t, bass._id)).map((x) => x.role)).toEqual(["user", "user"]);
    expect((await chat(t, jamId)).some((r) => r.kind === "system" && /declined/.test(r.text))).toBe(true);
  });
});

describe("S9b: the band watchdog", () => {
  test("a turn that never reports back is reclaimed after its deadline", async () => {
    const { t, jamId, bass } = await setup();
    await script(t, "bass", 0, { hang: true });
    await t.mutation(api.chat.send, { jamId, text: "@bass busier", octave: 3 });
    await settle(t);
    expect((await musician(t, bass._id)).status).toBe("thinking");
    vi.advanceTimersByTime(46_000);
    await t.mutation(internal.turn.watchdog, {});
    expect((await musician(t, bass._id)).status).toBe("idle");
    expect((await chat(t, jamId)).map((r) => r.text)).toContain("bass stopped responding. Still on v1.");
  });
});

describe("S10a: turns and history", () => {
  test("a two-call turn is one version", async () => {
    const { t, jamId, bass } = await setup();
    const lib = await t.query(api.library.list, { role: "bass" });
    const sub = lib.find((r) => r.starterKey === "bass-sub")!;
    await script(t, "bass", 0, {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "set_pattern", input: { say: "Eighths.", lengthBars: 1, notes: [0, 2, 4, 6].map((step) => ({ step, deg: 0, len: 1, vel: 0.8, accent: false })) } },
        { type: "tool_use", id: "t2", name: "use_library_sound", input: { say: "On the sub.", name: sub.name } },
      ],
    });
    await t.mutation(api.chat.send, { jamId, text: "@bass busier and deeper", octave: 3 });
    await settle(t);
    const rail = await t.query(api.parts.rail, { musicianId: bass._id });
    expect(rail).toHaveLength(2);
    const p = (await strip(t, bass._id)).part;
    expect(p).toMatchObject({ source: "agent", libraryId: sub._id, label: "Eighths. / On the sub." });
    expect(p.notes).toHaveLength(4);
  });

  test("← on a thinking musician discards its result: your rollback wins", async () => {
    const { t, jamId, bass } = await setup();
    await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: (await t.query(api.library.list, { role: "bass" })).find((r) => r.starterKey === "bass-sub")!._id });
    await t.mutation(api.chat.send, { jamId, text: "@bass busier", octave: 3 });
    await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "step", dir: -1 } }); // before the turn lands
    await settle(t);
    const p = (await strip(t, bass._id)).part;
    expect(p.source).toBe("history");
    expect(p.basedOn).toBe(1);
    expect((await musician(t, bass._id)).status).toBe("idle");
  });

  test("← while the model is already answering: the late commit is fenced out, your rollback stays", async () => {
    vi.useRealTimers();
    const { t, jamId, bass } = await setup();
    await t.mutation(api.parts.pick, { musicianId: bass._id, libraryId: (await t.query(api.library.list, { role: "bass" })).find((r) => r.starterKey === "bass-sub")!._id });
    await script(t, "bass", 0, { delay: 300 }); // then the fake's default answer
    await t.mutation(api.chat.send, { jamId, text: "@bass busier", octave: 3 });
    await new Promise((r) => setTimeout(r, 100)); // the action has its plan and is mid-call
    await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "step", dir: -1 } });
    await t.finishAllScheduledFunctions(() => {});
    const p = (await strip(t, bass._id)).part;
    expect(p.source).toBe("history");
    expect(p.basedOn).toBe(1);
    expect((await log(t, bass._id)).map((x) => x.role)).toEqual(["user"]); // nothing from the late answer
  });

  test("the rollback note appears in the next snapshot", async () => {
    const { t, jamId, bass } = await setup();
    await t.mutation(api.chat.send, { jamId, text: "@bass busier", octave: 3 });
    await settle(t); // v2 (agent)
    await t.mutation(api.parts.history, { musicianId: bass._id, move: { kind: "step", dir: -1 } }); // back to v1
    await t.mutation(api.chat.send, { jamId, text: "@bass what now?", octave: 3 });
    await settle(t);
    const l = await log(t, bass._id);
    const lastUser = l.filter((x) => x.role === "user").map((x) => JSON.stringify(x.content)).find((c) => c.includes("what now?"))!;
    expect(lastUser).toMatch(/took you back from v2 \(.+\) to v1; don't re-propose it unless asked/);
  });

  test("a note to the whole band reaches every agent; drums answer with a drum pattern", async () => {
    const { t, jamId, drums, bass, keys } = await setup();
    await t.mutation(api.chat.send, { jamId, text: "everyone busier", octave: 3 });
    for (const m of [drums, bass, keys]) expect((await musician(t, m._id)).status).toBe("thinking");
    await settle(t);
    expect((await strip(t, drums._id)).part.source).toBe("agent");
  });
});
