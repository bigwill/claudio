/// <reference types="vite/client" />
/**
 * Slice 4 rails, convex-test layer: S2 (WAV design), S2b (prompt design),
 * S8 (design failures and the held inbox), plus the design watchdog.
 *
 * Driven with the fake LLM (CLAUDIO_FAKE_LLM=1) and fake timers. `settle()`
 * runs whatever is due now (a design turn's action) but not the render lease
 * backstop, so the test plays the browser: it submits each measurement.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { inboxPlan } from "./model/inbox";

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CLAUDIO_FAKE_LLM", "1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const frame = (label: "attack" | "early" | "sustain" | "release", tMs: number) => ({
  label,
  tMs,
  rmsDb: -6,
  harmonicsDb: [0, -6, -12, -18, -24, -30, -36, -42, -48, -54, -60, -66],
  centroidRatio: 3,
});
const FEATURES = {
  sampleRate: 48000,
  durationMs: 1500,
  f0Hz: 220,
  f0Confidence: 0.9,
  f0DriftCents: 0,
  amp: { attackMs: 10, decayMs: 400, sustainLevel: 0.2, releaseMs: 300 },
  inharmonicityCents: 20,
  noiseRatio: 0.1,
  oddEvenBalance: 0.5,
  frames: [frame("attack", 20), frame("early", 200), frame("sustain", 700), frame("release", 1300)],
};
const SPEC = { f0: 220, durationMs: 1500, sampleRate: 48000, gateMs: 1000 };
const diff = (distance: number) => ({
  distance,
  breakdown: { spectrum: distance / 2, envelope: distance / 4, pitch: distance / 8, noise: distance / 8 },
  verdict: `${distance}/100`,
  priorities: ["Brighten it."],
  scalars: [],
  harmonics: [],
});

type T = ReturnType<typeof convexTest>;

async function settle(t: T) {
  vi.advanceTimersByTime(1);
  await t.finishInProgressScheduledFunctions();
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.jams.create, { slug: "DESIGNTEST01" });
  const s = (await t.query(api.jams.state, { slug: "DESIGNTEST01" }))!;
  const keys = s.musicians.find((m) => m.role === "keys")!;
  return { t, jamId: s.jam._id, keys };
}

const designOf = (t: T, id: Id<"designs">) => t.run((ctx) => ctx.db.get(id)).then((d) => d!);
const musician = (t: T, id: Id<"musicians">) => t.run((ctx) => ctx.db.get(id)).then((m) => m!);

async function startWav(t: T, musicianId: Id<"musicians">) {
  return await t.mutation(api.designs.start, {
    musicianId,
    source: { kind: "wav", features: FEATURES, info: { filename: "electric_piano.wav", durationSec: 1.5, sampleRate: 48000 }, audioId: null },
    spec: SPEC,
  });
}

/** Play the browser: measure each proposal until the design ends. */
async function measureUntilDone(t: T, designId: Id<"designs">, distances: number[]) {
  for (const distance of distances) {
    await settle(t);
    const d = await designOf(t, designId);
    if (d.status !== "awaiting_render") return;
    const r = await t.mutation(api.render.submitAnalysis, {
      designId,
      clientId: "test-browser",
      presetId: d.pendingPresetId!,
      features: FEATURES,
      diff: diff(distance),
    });
    expect(r.accepted).toBe(true);
  }
  await settle(t);
}

describe("S2: a WAV design on keys", () => {
  test("measured iterations, then finalize: a designed library row and a design part; the musician is freed", async () => {
    const { t, jamId, keys } = await setup();
    const designId = await startWav(t, keys._id);
    expect((await musician(t, keys._id)).activeDesignId).toBe(designId);
    await expect(t.mutation(api.jams.start, { jamId })).rejects.toThrow(/design/);

    await measureUntilDone(t, designId, [40, 35, 30]);
    const d = await designOf(t, designId);
    expect(d.status).toBe("done");
    const attempts = await t.run((ctx) =>
      ctx.db.query("attempts").withIndex("by_design_iteration", (q) => q.eq("designId", designId)).collect(),
    );
    expect(attempts.filter((a) => a.distance !== null).length).toBeGreaterThanOrEqual(2);
    const final = attempts.find((a) => a.isFinal)!;

    const lib = await t.query(api.library.list, { role: "keys" });
    const designed = lib.find((r) => r.origin === "designed")!;
    expect(designed).toMatchObject({ name: final.preset.name, source: "electric_piano.wav" });

    const s = (await t.query(api.jams.state, { slug: "DESIGNTEST01" }))!;
    const k = s.musicians.find((m) => m._id === keys._id)!;
    expect(k.part).toMatchObject({ source: "design", libraryId: designed._id });
    expect(k.part.sound?.name).toBe(final.preset.name);
    expect(k.activeDesignId).toBeNull();

    const chat = await t.query(api.jams.chat, { jamId });
    expect(chat.some((r) => r.kind === "system" && r.to.includes(keys._id) && r.text.includes(final.preset.name))).toBe(true);
    await t.mutation(api.jams.start, { jamId }); // no longer refused
  });

  test("a second design on the same musician, or a design on drums, is refused", async () => {
    const { t, keys } = await setup();
    await startWav(t, keys._id);
    await expect(startWav(t, keys._id)).rejects.toThrow(/design/);
    const s = (await t.query(api.jams.state, { slug: "DESIGNTEST01" }))!;
    const drums = s.musicians.find((m) => m.role === "drums")!;
    await expect(startWav(t, drums._id)).rejects.toThrow(/kit/);
  });

  test("cancel ends the design, frees the musician, and closes the pending tool_use", async () => {
    const { t, keys } = await setup();
    const designId = await startWav(t, keys._id);
    await settle(t); // a proposal is now awaiting its render
    await t.mutation(api.designs.cancel, { designId });
    expect((await designOf(t, designId)).status).toBe("failed");
    expect((await musician(t, keys._id)).activeDesignId).toBeNull();
    const log = await t.run((ctx) => ctx.db.query("messages").withIndex("by_convo_seq", (q) => q.eq("convoId", designId)).collect());
    expect(log.at(-1)!.role).toBe("user"); // the tool_use was answered
  });
});

describe("S2b: a design from a description", () => {
  test("prompt origin → finalize → a designed library row whose source is the prompt", async () => {
    const { t, keys } = await setup();
    const designId = await t.mutation(api.designs.start, {
      musicianId: keys._id,
      source: { kind: "prompt", text: "a glassy bell, quite short" },
      spec: SPEC,
    });
    for (let i = 0; i < 4; i++) {
      await settle(t);
      const d = await designOf(t, designId);
      if (d.status !== "awaiting_render") break;
      await t.mutation(api.render.submitAnalysis, { designId, clientId: "b", presetId: d.pendingPresetId!, features: FEATURES, diff: null });
    }
    await settle(t);
    expect((await designOf(t, designId)).status).toBe("done");
    const lib = await t.query(api.library.list, { role: "keys" });
    expect(lib.find((r) => r.origin === "designed")?.source).toBe("a glassy bell, quite short");
  });
});

describe("S8: design failures", () => {
  async function scripted(responses: unknown[]) {
    const ctx = await setup();
    for (const [turnIndex, response] of responses.entries()) {
      await ctx.t.mutation(api.testing.setScript, { match: "design", turnIndex, response });
    }
    return ctx;
  }

  test("a refusal saves nothing, fails the design and frees the musician", async () => {
    const { t, jamId, keys } = await scripted([{ stop_reason: "refusal", content: [] }]);
    const designId = await startWav(t, keys._id);
    await settle(t);
    expect((await designOf(t, designId)).status).toBe("failed");
    expect((await musician(t, keys._id)).activeDesignId).toBeNull();
    const log = await t.run((ctx) => ctx.db.query("messages").withIndex("by_convo_seq", (q) => q.eq("convoId", designId)).collect());
    expect(log.map((m) => m.role)).toEqual(["user"]); // no assistant turn saved
    const chat = await t.query(api.jams.chat, { jamId });
    expect(chat.some((r) => r.kind === "system" && /declined/i.test(r.text))).toBe(true);
  });

  test("max_tokens with no tool call fails the design", async () => {
    const { t, keys } = await scripted([{ stop_reason: "max_tokens", content: [{ type: "text", text: "thinking…" }] }]);
    const designId = await startWav(t, keys._id);
    await settle(t);
    expect((await designOf(t, designId)).status).toBe("failed");
    expect((await musician(t, keys._id)).activeDesignId).toBeNull();
  });

  test("no-tool guard: one text-only turn gets a nudge and another turn; the second strike fails", async () => {
    const text = { stop_reason: "end_turn", content: [{ type: "text", text: "Here's my idea…" }] };
    const { t, keys } = await scripted([text, text]);
    const designId = await startWav(t, keys._id);
    await settle(t);
    let d = await designOf(t, designId);
    expect(d.noToolStrikes).toBe(1);
    expect(d.status).toBe("thinking");
    const log = await t.run((ctx) => ctx.db.query("messages").withIndex("by_convo_seq", (q) => q.eq("convoId", designId)).collect());
    expect(JSON.parse(log.at(-1)!.content)).toEqual([{ type: "text", text: "Call propose_preset or finalize now." }]);
    await settle(t);
    d = await designOf(t, designId);
    expect(d.status).toBe("failed");
    expect(d.noToolStrikes).toBe(2);
    expect((await musician(t, keys._id)).activeDesignId).toBeNull();
  });

  test("one strike then a proposal carries on normally", async () => {
    const { t, keys } = await scripted([{ stop_reason: "end_turn", content: [{ type: "text", text: "hmm" }] }]);
    const designId = await startWav(t, keys._id);
    await settle(t);
    await settle(t);
    expect((await designOf(t, designId)).status).toBe("awaiting_render");
  });

  test("a note held during the design is delivered afterwards: it starts that musician's band turn", async () => {
    // Was "…is waiting in the inbox…" (slice 4, before band turns existed).
    // Changed in slice 5 to what S8 specifies; see the plan's change log.
    const { t, jamId, keys } = await scripted([{ stop_reason: "refusal", content: [] }]);
    const designId = await startWav(t, keys._id);
    await t.mutation(api.chat.send, { jamId, text: "@keys glassier please", octave: 4 });
    expect(await t.run((ctx) => inboxPlan(ctx, keys._id))).toEqual({ action: "hold" });
    await settle(t); // the design refuses and ends; the held note starts a band turn
    expect((await designOf(t, designId)).status).toBe("failed");
    const m = await musician(t, keys._id);
    expect(m.status).toBe("thinking");
    const log = await t.run((ctx) => ctx.db.query("messages").withIndex("by_convo_seq", (q) => q.eq("convoId", keys._id)).collect());
    expect(log.at(-1)!.content).toContain("glassier please");
  });
});

describe("design watchdog", () => {
  test("a design turn that never reports back is failed and its musician freed", async () => {
    const { t, keys } = await setup();
    const designId = await startWav(t, keys._id);
    // The action never ran (no settle); pretend its lease ran out.
    await t.run((ctx) => ctx.db.patch(designId, { turnDeadline: 1 }));
    await t.mutation(internal.turn.watchdog, {});
    expect((await designOf(t, designId)).status).toBe("failed");
    expect((await musician(t, keys._id)).activeDesignId).toBeNull();
  });
});

describe("designing from the chat (Will, 2026-09-22)", () => {
  test("\"@keys design …\" starts a measured design, logged as a system row, never as a note the musician answers later", async () => {
    const { t, jamId, keys } = await setup();
    await t.mutation(api.chat.send, { jamId, text: "@keys design a glassy bell, quite short", octave: 4, spec: SPEC });
    const m = await musician(t, keys._id);
    expect(m.activeDesignId).not.toBeNull();
    const d = await designOf(t, m.activeDesignId!);
    expect(d).toMatchObject({ origin: "prompt", prompt: "a glassy bell, quite short" });
    const chat = await t.query(api.jams.chat, { jamId });
    expect(chat.map((r) => [r.kind, r.text])).toEqual([["system", "Designing keys: a glassy bell, quite short"]]);

    for (let i = 0; i < 4; i++) {
      await settle(t);
      const cur = await designOf(t, d._id);
      if (cur.status !== "awaiting_render") break;
      await t.mutation(api.render.submitAnalysis, { designId: d._id, clientId: "b", presetId: cur.pendingPresetId!, features: FEATURES, diff: null });
    }
    await settle(t);
    expect((await designOf(t, d._id)).status).toBe("done");
    expect(await t.run((ctx) => inboxPlan(ctx, keys._id))).not.toMatchObject({ action: "turn" });
  });

  test("\"@me …\" designs your own sound", async () => {
    const { t, jamId } = await setup();
    await t.mutation(api.chat.send, { jamId, text: "@me a warm pad with a slow attack", octave: 4, spec: SPEC });
    const s = (await t.query(api.jams.state, { slug: "DESIGNTEST01" }))!;
    expect(s.musicians.find((x) => x.role === "producer")!.activeDesignId).not.toBeNull();
  });

  test("a refused route throws with the reason and writes nothing", async () => {
    const { t, jamId } = await setup();
    await expect(t.mutation(api.chat.send, { jamId, text: "@drums design a tight kit", octave: 4, spec: SPEC })).rejects.toThrow(/kit/);
    await expect(t.mutation(api.chat.send, { jamId, text: "@bass @keys design a warm pad", octave: 4, spec: SPEC })).rejects.toThrow(/one musician/);
    expect(await t.query(api.jams.chat, { jamId })).toEqual([]);
  });

  test("a design note to a musician already designing is refused, not held", async () => {
    const { t, jamId, keys } = await setup();
    await startWav(t, keys._id);
    await expect(t.mutation(api.chat.send, { jamId, text: "@keys design a glassy bell", octave: 4, spec: SPEC })).rejects.toThrow(/already designing/);
  });

  test("a WAV design is logged in the chat too", async () => {
    const { t, jamId, keys } = await setup();
    await startWav(t, keys._id);
    const chat = await t.query(api.jams.chat, { jamId });
    expect(chat.map((r) => r.text)).toEqual(["Designing keys from electric_piano.wav"]);
  });
});
