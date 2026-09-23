/**
 * Test-only surface for the fake LLM.
 *
 * `ping` always answers, so `npm run e2e` can preflight that it's talking to a
 * fake deployment and abort otherwise. Everything else refuses unless
 * CLAUDIO_FAKE_LLM=1: the scripts table exists on every deployment, and this
 * guard is what keeps a scripted "model" off a real one.
 */
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { fakeLlmEnabled } from "./fakeClaude";

function requireFake(): void {
  if (!fakeLlmEnabled()) {
    throw new Error("testing:* is disabled: set CLAUDIO_FAKE_LLM=1 on this deployment");
  }
}

export const ping = query({
  args: {},
  handler: async () => ({ fake: fakeLlmEnabled() }),
});

/** Upsert the script for one (match, turnIndex). */
export const setScript = mutation({
  args: { match: v.string(), turnIndex: v.number(), response: v.any() },
  handler: async (ctx, args) => {
    requireFake();
    const existing = await ctx.db
      .query("fakeScripts")
      .withIndex("by_match_turn", (q) => q.eq("match", args.match).eq("turnIndex", args.turnIndex))
      .unique();
    if (existing) {
      await ctx.db.replace(existing._id, args);
    } else {
      await ctx.db.insert("fakeScripts", args);
    }
  },
});

export const listScripts = query({
  args: {},
  handler: async (ctx) => {
    requireFake();
    return await ctx.db.query("fakeScripts").take(500);
  },
});

export const clearScripts = mutation({
  args: {},
  handler: async (ctx) => {
    requireFake();
    for (const row of await ctx.db.query("fakeScripts").take(500)) {
      await ctx.db.delete(row._id);
    }
  },
});
