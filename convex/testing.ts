/**
 * Test-only surface for the fake LLM.
 *
 * `ping` always answers, so `npm run e2e` can preflight that it's talking to a
 * fake deployment and abort otherwise. Everything else refuses unless
 * CLAUDIO_FAKE_LLM=1: the scripts table exists on every deployment, and this
 * guard is what keeps a scripted "model" off a real one.
 */
import { v } from "convex/values";

import { internalQuery, mutation, query } from "./_generated/server";
import { fakeLlmEnabled } from "./fakeClaude";

function requireFake(): void {
  if (!fakeLlmEnabled()) {
    throw new Error("testing:* is disabled: set CLAUDIO_FAKE_LLM=1 on this deployment");
  }
}

export const ping = query({
  args: {},
  returns: v.object({ fake: v.boolean() }),
  handler: async () => ({ fake: fakeLlmEnabled() }),
});

/** Upsert the script for one (match, turnIndex). */
export const setScript = mutation({
  args: { match: v.string(), turnIndex: v.number(), response: v.any() },
  returns: v.null(),
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
    return null;
  },
});

/** The fake LLM's lookup: the scripted response for (match, turnIndex), if any. */
export const scriptFor = internalQuery({
  args: { match: v.string(), turnIndex: v.number() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    requireFake();
    const row = await ctx.db
      .query("fakeScripts")
      .withIndex("by_match_turn", (q) => q.eq("match", args.match).eq("turnIndex", args.turnIndex))
      .unique();
    // JSON text: a scripted tool_use must keep its key order, like a real one.
    return row ? JSON.stringify(row.response) : null;
  },
});

export const listScripts = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("fakeScripts"), _creationTime: v.number(), match: v.string(), turnIndex: v.number(), response: v.any() })),
  handler: async (ctx) => {
    requireFake();
    return await ctx.db.query("fakeScripts").take(500);
  },
});

export const clearScripts = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    requireFake();
    for (const row of await ctx.db.query("fakeScripts").take(500)) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

/**
 * Delete test jams (slug prefix, e.g. "E2E") and everything they made: parts,
 * chat, logs, designs and their library rows, so the global library isn't
 * filled with test sounds. Bounded per call; returns rows deleted, so callers
 * repeat until it returns 0 (npm run e2e does).
 */
export const clearTestJams = mutation({
  args: { prefix: v.string() },
  returns: v.number(),
  handler: async (ctx, { prefix }) => {
    requireFake();
    if (prefix.length < 2) throw new Error("clearTestJams needs a prefix of 2+ characters");
    const jam = await ctx.db
      .query("jams")
      .withIndex("by_slug", (q) => q.gte("slug", prefix).lt("slug", `${prefix}\uffff`))
      .first();
    if (!jam) return 0;
    let n = 0;
    const del = async (ids: Array<{ _id: Parameters<typeof ctx.db.delete>[0] }>) => {
      for (const d of ids) await ctx.db.delete(d._id);
      n += ids.length;
    };
    const musicians = await ctx.db.query("musicians").withIndex("by_jam", (q) => q.eq("jamId", jam._id)).take(4);
    for (const m of musicians) {
      await del(await ctx.db.query("parts").withIndex("by_musician_version", (q) => q.eq("musicianId", m._id)).take(200));
      await del(await ctx.db.query("messages").withIndex("by_convo_seq", (q) => q.eq("convoId", m._id)).take(200));
      for (const d of await ctx.db.query("designs").withIndex("by_musician", (q) => q.eq("musicianId", m._id)).take(10)) {
        await del(await ctx.db.query("attempts").withIndex("by_design_iteration", (q) => q.eq("designId", d._id)).take(50));
        await del(await ctx.db.query("messages").withIndex("by_convo_seq", (q) => q.eq("convoId", d._id)).take(100));
        await del([d]);
      }
    }
    await del(await ctx.db.query("chat").withIndex("by_jam_seq", (q) => q.eq("jamId", jam._id)).take(300));
    for (const role of ["bass", "keys"] as const) {
      await del(await ctx.db.query("library").withIndex("by_role_jam", (q) => q.eq("role", role).eq("fromJamId", jam._id)).take(100));
    }
    if (n > 0) return n; // more to do next call, before the jam itself goes
    await del(await ctx.db.query("jamCounters").withIndex("by_jam", (q) => q.eq("jamId", jam._id)).take(1));
    await del(musicians);
    await del([jam]);
    return n;
  },
});
