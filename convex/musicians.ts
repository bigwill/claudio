/**
 * Mute is not history (plan §1): it lives on the musician and writes no part.
 * The client mutes its channel first and calls this with an optimistic update.
 */
import { ConvexError, v } from "convex/values";

import { mutation } from "./_generated/server";

export const setMuted = mutation({
  args: { musicianId: v.id("musicians"), muted: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { musicianId, muted }) => {
    const m = await ctx.db.get(musicianId);
    if (!m) throw new ConvexError("no such musician");
    if (m.muted !== muted) await ctx.db.patch(musicianId, { muted });
    return null;
  },
});
