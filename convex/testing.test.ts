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
