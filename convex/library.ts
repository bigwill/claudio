/**
 * The global library: starters, designed sounds and tweaks, newest first.
 * `pitched` is every bass and keys sound (what the producer can pick from).
 */
import { v } from "convex/values";

import { query } from "./_generated/server";
import { vLibraryOrigin, vPitchedRole } from "./schema";
import { vPreset } from "./validators";

export const list = query({
  args: { role: v.union(v.literal("bass"), v.literal("keys"), v.literal("pitched")) },
  returns: v.array(
    v.object({
      _id: v.id("library"),
      name: v.string(),
      role: vPitchedRole,
      origin: vLibraryOrigin,
      source: v.string(),
      starterKey: v.union(v.null(), v.string()),
      preset: vPreset,
    }),
  ),
  handler: async (ctx, { role }) => {
    const roles = role === "pitched" ? (["bass", "keys"] as const) : [role];
    const rows = (
      await Promise.all(
        roles.map((r) =>
          ctx.db
            .query("library")
            .withIndex("by_role", (q) => q.eq("role", r))
            .order("desc")
            .take(100),
        ),
      )
    ).flat();
    return rows
      .sort((a, b) => b._creationTime - a._creationTime)
      .map((r) => ({
        _id: r._id,
        name: r.name,
        role: r.role,
        origin: r.origin,
        source: r.source,
        starterKey: r.starterKey,
        preset: r.preset,
      }));
  },
});
