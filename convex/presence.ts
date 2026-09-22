/**
 * Who is here.
 *
 * Its own table, its own subscription, and — importantly — a heartbeat that
 * reads NOTHING else. If it loaded the session document, that read would join
 * the OCC conflict domain of every turn commit and lease claim, so a handful of
 * contributors beating every 10 seconds would start losing races with the loop
 * itself. The client passes the session id it already has from its subscription.
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { presentClients, sweepStalePresence } from "./model/presence";
import { sanitizeNickname } from "../src/shared/protocol";

export const list = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await presentClients(ctx, args.sessionId, now);
    return rows
      .map((p) => ({
        clientId: p.clientId,
        nickname: p.nickname,
        color: p.color,
        joinedAt: p.joinedAt,
        lastSeen: p.lastSeen,
      }))
      .sort((a, b) => a.joinedAt - b.joinedAt);
  },
});

/**
 * Beat, and get the server's clock back.
 *
 * The return value is load-bearing: the client needs server time to reason about
 * lease deadlines, and reading `Date.now()` inside a QUERY is a documented Convex
 * anti-pattern — it invalidates the query cache more often than necessary, and a
 * cached result would hand back a stale `now` paired with a fresh receive time,
 * making every lease look longer than it is. A mutation's result is never cached,
 * and this one already runs every 10 seconds.
 */
export const heartbeat = mutation({
  args: {
    sessionId: v.id("sessions"),
    clientId: v.string(),
    nickname: v.string(),
    color: v.string(),
    /** ms epoch through which this client expects to be playing notes. */
    playingUntil: v.number(),
  },
  returns: v.object({ now: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const nickname = sanitizeNickname(args.nickname);

    const existing = await ctx.db
      .query("presence")
      .withIndex("by_session_client", (q) =>
        q.eq("sessionId", args.sessionId).eq("clientId", args.clientId),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        nickname,
        color: args.color,
        lastSeen: now,
        playingUntil: args.playingUntil,
      });
    } else {
      await ctx.db.insert("presence", {
        sessionId: args.sessionId,
        clientId: args.clientId,
        nickname,
        color: args.color,
        joinedAt: now,
        lastSeen: now,
        playingUntil: args.playingUntil,
      });
      await sweepStalePresence(ctx, args.sessionId, now);
    }
    return { now };
  },
});

/**
 * Leaving is a WRITE, which is the point.
 *
 * A lease expiring is invisible to subscriptions — nothing changed in the
 * database — so waiting one out costs everyone dead air. A tab closing, on the
 * other hand, can tell us, and every subscriber hears it immediately. That makes
 * this the fast path that keeps a closed tab from stalling the loop.
 */
export const leave = mutation({
  args: { sessionId: v.id("sessions"), clientId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("presence")
      .withIndex("by_session_client", (q) =>
        q.eq("sessionId", args.sessionId).eq("clientId", args.clientId),
      )
      .first();
    if (row) await ctx.db.delete(row._id);

    // If they were holding a render, hand it on now rather than at lease expiry.
    await ctx.scheduler.runAfter(0, internal.render.releaseOnLeave, {
      sessionId: args.sessionId,
      clientId: args.clientId,
    });
    return null;
  },
});
