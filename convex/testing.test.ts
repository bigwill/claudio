/// <reference types="vite/client" />
/**
 * Slice 0 rail, convex-test layer: the fake-LLM guard.
 *
 * `fakeScripts` exists in the schema on every deployment, so the only thing
 * standing between a real deployment and a scripted "model" is this guard.
 * `ping` always answers (it's how `npm run e2e` preflights); everything else in
 * `testing:*` refuses unless CLAUDIO_FAKE_LLM=1.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const script = { match: "busier", turnIndex: 0, response: { stay: true } };

afterEach(() => vi.unstubAllEnvs());

describe("testing:ping", () => {
  test("reports fake:false when the flag is unset", async () => {
    vi.stubEnv("CLAUDIO_FAKE_LLM", "");
    const t = convexTest(schema, modules);
    expect(await t.query(api.testing.ping, {})).toEqual({ fake: false });
  });

  test("reports fake:true when CLAUDIO_FAKE_LLM=1", async () => {
    vi.stubEnv("CLAUDIO_FAKE_LLM", "1");
    const t = convexTest(schema, modules);
    expect(await t.query(api.testing.ping, {})).toEqual({ fake: true });
  });
});

describe("testing:* refuses without the fake flag", () => {
  test("setScript throws and writes nothing", async () => {
    vi.stubEnv("CLAUDIO_FAKE_LLM", "");
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.testing.setScript, script)).rejects.toThrow(/CLAUDIO_FAKE_LLM/);
    const rows = await t.run((ctx) => ctx.db.query("fakeScripts").collect());
    expect(rows).toEqual([]);
  });

  test("listScripts throws", async () => {
    vi.stubEnv("CLAUDIO_FAKE_LLM", "");
    const t = convexTest(schema, modules);
    await expect(t.query(api.testing.listScripts, {})).rejects.toThrow(/CLAUDIO_FAKE_LLM/);
  });

  test("clearScripts throws and deletes nothing", async () => {
    vi.stubEnv("CLAUDIO_FAKE_LLM", "");
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("fakeScripts", script));
    await expect(t.mutation(api.testing.clearScripts, {})).rejects.toThrow(/CLAUDIO_FAKE_LLM/);
    const rows = await t.run((ctx) => ctx.db.query("fakeScripts").collect());
    expect(rows).toHaveLength(1);
  });
});

describe("testing:* with the fake flag", () => {
  test("setScript then listScripts round-trips; clearScripts empties", async () => {
    vi.stubEnv("CLAUDIO_FAKE_LLM", "1");
    const t = convexTest(schema, modules);
    await t.mutation(api.testing.setScript, script);
    const listed = await t.query(api.testing.listScripts, {});
    expect(listed.map(({ match, turnIndex, response }) => ({ match, turnIndex, response }))).toEqual([
      script,
    ]);
    await t.mutation(api.testing.clearScripts, {});
    expect(await t.query(api.testing.listScripts, {})).toEqual([]);
  });

  test("setScript replaces the row for the same (match, turnIndex)", async () => {
    vi.stubEnv("CLAUDIO_FAKE_LLM", "1");
    const t = convexTest(schema, modules);
    await t.mutation(api.testing.setScript, script);
    await t.mutation(api.testing.setScript, { ...script, response: { hang: true } });
    const listed = await t.query(api.testing.listScripts, {});
    expect(listed).toHaveLength(1);
    expect(listed[0].response).toEqual({ hang: true });
  });
});

describe("testing:clearTestJams", () => {
  test("removes test jams (by slug prefix) and everything they made, including their library rows; keeps the rest", async () => {
    vi.stubEnv("CLAUDIO_FAKE_LLM", "1");
    const t = convexTest(schema, modules);
    await t.mutation(api.jams.create, { slug: "E2EXAMPLE001" });
    await t.mutation(api.jams.create, { slug: "KEEPME000001" });
    const s = (await t.query(api.jams.state, { slug: "E2EXAMPLE001" }))!;
    const keys = s.musicians.find((m) => m.role === "keys")!;
    await t.run(async (ctx) => {
      await ctx.db.insert("library", {
        name: "Init",
        role: "keys",
        preset: (await ctx.db.query("library").first())!.preset,
        features: null,
        origin: "designed",
        source: "x.wav",
        designId: null,
        fromJamId: s.jam._id,
        starterKey: null,
      });
      await ctx.db.insert("messages", { convoId: keys._id, seq: 0, role: "user", content: "[]" });
    });
    await t.mutation(api.chat.send, { jamId: s.jam._id, text: "hello band", octave: 4 });

    let removed = 1;
    while (removed > 0) removed = await t.mutation(api.testing.clearTestJams, { prefix: "E2E" });

    const left = await t.run(async (ctx) => ({
      jams: (await ctx.db.query("jams").collect()).map((j) => j.slug),
      musicians: (await ctx.db.query("musicians").collect()).length,
      chat: (await ctx.db.query("chat").collect()).length,
      messages: (await ctx.db.query("messages").collect()).length,
      designedOrTweak: (await ctx.db.query("library").collect()).filter((l) => l.origin !== "starter").length,
      starters: (await ctx.db.query("library").collect()).filter((l) => l.origin === "starter").length,
    }));
    expect(left).toEqual({ jams: ["KEEPME000001"], musicians: 4, chat: 0, messages: 0, designedOrTweak: 0, starters: 5 });
  });

  test("refuses without the fake flag, and refuses an empty prefix", async () => {
    vi.stubEnv("CLAUDIO_FAKE_LLM", "");
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.testing.clearTestJams, { prefix: "E2E" })).rejects.toThrow(/CLAUDIO_FAKE_LLM/);
    vi.stubEnv("CLAUDIO_FAKE_LLM", "1");
    await expect(t.mutation(api.testing.clearTestJams, { prefix: "" })).rejects.toThrow(/prefix/);
  });
});
