/**
 * Design jobs (plan §4): the measured sound-design loop, run for one musician
 * during soundcheck. `start` is the only way in; `cancel` ends one early.
 * Browsers render proposals: `renderJob` is what they need, `render.claimRender`
 * decides who, and `render.submitAnalysis` reports back.
 */

import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { endDesign, startDesign } from "./model/design";
import { appendMessage } from "./model/messages";
import { vFeatureSummary, vRenderSpec, vTargetInfo, vPreset } from "./validators";

export const vSource = v.union(
  v.object({ kind: v.literal("wav"), features: vFeatureSummary, info: vTargetInfo, audioId: v.union(v.null(), v.id("_storage")) }),
  v.object({ kind: v.literal("prompt"), text: v.string() }),
);

/** Upload slot for the prepared target audio, so the rail can preview it after a reload. */
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const start = mutation({
  args: { musicianId: v.id("musicians"), source: vSource, spec: vRenderSpec },
  returns: v.id("designs"),
  handler: async (ctx, { musicianId, source, spec }) => await startDesign(ctx, musicianId, source, spec),
});

/** End a design early. Its pending tool_use, if any, is answered so the log stays valid. */
export const cancel = mutation({
  args: { designId: v.id("designs") },
  returns: v.null(),
  handler: async (ctx, { designId }) => {
    const design = await ctx.db.get(designId);
    if (!design || design.status === "done" || design.status === "failed") return null;
    if (design.pendingToolUseId) {
      await appendMessage(ctx, designId, {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: design.pendingToolUseId,
            is_error: true,
            content: "The producer cancelled this design.",
          },
        ],
      });
    }
    await endDesign(ctx, design, { kind: "failed", why: "cancelled" });
    return null;
  },
});

/** What a browser needs to render the pending proposal. */
export const renderJob = query({
  args: { designId: v.id("designs") },
  returns: v.union(
    v.null(),
    v.object({
      presetId: v.string(),
      preset: vPreset,
      spec: vRenderSpec,
      target: v.union(v.null(), vFeatureSummary),
      attemptNo: v.number(),
      ownerClientId: v.union(v.null(), v.string()),
      leaseUntil: v.number(),
    }),
  ),
  handler: async (ctx, { designId }) => {
    const d = await ctx.db.get(designId);
    if (!d || d.status !== "awaiting_render" || !d.pendingPresetId || !d.renderSpec) return null;
    const attempt = await ctx.db
      .query("attempts")
      .withIndex("by_design_preset", (q) => q.eq("designId", designId).eq("presetId", d.pendingPresetId!))
      .first();
    if (!attempt) return null;
    return {
      presetId: d.pendingPresetId,
      preset: attempt.preset,
      spec: d.renderSpec,
      target: d.target,
      attemptNo: d.renderAttemptNo,
      ownerClientId: d.renderOwnerClientId,
      leaseUntil: d.renderLeaseUntil,
    };
  },
});
