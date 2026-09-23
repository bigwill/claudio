/// <reference types="vite/client" />
/**
 * The Anthropic log must be replayed EXACTLY as the model returned it.
 *
 * Convex stores object fields sorted by key, so a stored tool_use input comes
 * back alphabetized (`ampEnv, carrierFm, …, name`) while the strict schema made
 * the model write it `name, harmonicity, modulationIndex, …`. Replaying the
 * reordered call made later design turns stub those leading fields ("x", 0,
 * "placeholder"); the Worker-era original stored JSON text and never did.
 * So the log stores each message's content as its JSON text.
 */
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";
import { appendMessage, loadMessages } from "./model/messages";

const modules = import.meta.glob("./**/*.ts");

const assistantTurn = [
  {
    type: "tool_use",
    id: "toolu_1",
    name: "propose_preset",
    input: { preset: { name: "Soft Tine EP", harmonicity: 3.47, modulationIndex: 9, ampEnv: { attack: 0.015 } }, rationale: "r" },
  },
];

test("a message's content is stored as its exact JSON text", async () => {
  const t = convexTest(schema, modules);
  const row = await t.run(async (ctx) => {
    const id = await ctx.db.insert("sessions", sessionFixture());
    const session = (await ctx.db.get(id))!;
    await appendMessage(ctx, session, { role: "assistant", content: assistantTurn });
    return (await ctx.db.query("messages").first())!;
  });
  expect(row.content).toBe(JSON.stringify(assistantTurn));
});

test("loadMessages replays the content with the model's key order intact", async () => {
  const t = convexTest(schema, modules);
  const loaded = await t.run(async (ctx) => {
    const id = await ctx.db.insert("sessions", sessionFixture());
    const session = (await ctx.db.get(id))!;
    await appendMessage(ctx, session, { role: "assistant", content: assistantTurn });
    // Serialize inside t.run: returning an object out of it would pass through
    // Convex's value encoding and be key-sorted again on the way out.
    const content = (await loadMessages(ctx, id))[0].content as typeof assistantTurn;
    return { json: JSON.stringify(content), keys: Object.keys(content[0].input.preset) };
  });
  expect(loaded.json).toBe(JSON.stringify(assistantTurn));
  expect(loaded.keys).toEqual(["name", "harmonicity", "modulationIndex", "ampEnv"]);
});

test("planForAction hands the action the log as JSON text, key order intact", async () => {
  // Query return values cross into the action through Convex's value encoding,
  // which sorts keys; the log must travel as text or the API sees it reordered.
  const t = convexTest(schema, modules);
  const sessionId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("sessions", { ...sessionFixture(), status: "thinking" as const, turnSeq: 7 });
    const session = (await ctx.db.get(id))!;
    await appendMessage(ctx, session, { role: "assistant", content: assistantTurn });
    return id;
  });
  const plan = (await t.query(internal.turn.planForAction, { sessionId, turnSeq: 7 })) as { messagesJson: unknown } | null;
  expect(typeof plan?.messagesJson).toBe("string");
  const messages = JSON.parse(plan!.messagesJson as string) as Array<{ content: typeof assistantTurn }>;
  expect(Object.keys(messages[0].content[0].input.preset)).toEqual(["name", "harmonicity", "modulationIndex", "ampEnv"]);
});

function sessionFixture() {
  return {
    slug: "TESTSLUG0001",
    status: "idle" as const,
    statusSince: 0,
    target: null,
    targetInfo: null,
    targetAudioId: null,
    promptText: null,
    iteration: 0,
    maxIterations: 3,
    bestPresetId: null,
    bestDistance: null,
    pendingToolUseId: null,
    pendingPresetId: null,
    renderSpec: null,
    turnSeq: 0,
    turnDeadline: 0,
    turnStartedBy: null,
    turnForce: false,
    turnIsFirstProposal: false,
    turnJobId: null,
    renderOwnerClientId: null,
    renderLeaseUntil: 0,
    renderAttemptNo: 0,
    msgSeq: 0,
    chatSeq: 0,
    lastError: null,
    lastErrorRetryable: false,
  };
}
