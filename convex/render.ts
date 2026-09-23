/**
 * Measurements coming back from a browser, and who renders them (plan §1:
 * "Render ownership is claimRender's first-caller-wins lease, fenced by
 * renderAttemptNo, so any tab or browser showing the jam can render").
 *
 * The idempotency rule is unchanged from the original loop: a submission is
 * accepted only when the design is awaiting a render AND the presetId matches
 * the pending one, so a double-click, a retry or two racing browsers can't
 * desync the conversation. Losing a race returns {accepted:false}; it isn't
 * thrown, because it's normal traffic, not an error.
 */

import { v } from "convex/values";

import { internalMutation, mutation } from "./_generated/server";
import { beginDesignTurn, bestDistance, grantRender, iterationsRemaining, reopenOrAbandonRender } from "./model/design";
import { analysisToolResult, appendMessage, renderErrorToolResult } from "./model/messages";
import { vFeatureDiff, vFeatureSummary } from "./validators";

const vResult = v.object({ accepted: v.boolean(), reason: v.optional(v.string()) });

export const submitAnalysis = mutation({
  args: {
    designId: v.id("designs"),
    clientId: v.string(),
    presetId: v.string(),
    features: vFeatureSummary,
    /** Null for prompt-origin designs: no target to diff against. */
    diff: v.union(v.null(), vFeatureDiff),
  },
  returns: vResult,
  handler: async (ctx, args) => {
    const design = await ctx.db.get(args.designId);
    if (!design) return { accepted: false, reason: "no such design" };
    if (design.status !== "awaiting_render" || !design.pendingToolUseId) {
      return { accepted: false, reason: `Design is "${design.status}", not awaiting a render.` };
    }
    if (args.presetId !== design.pendingPresetId) {
      return { accepted: false, reason: `Stale preset: expected "${design.pendingPresetId}".` };
    }
    const toolUseId = design.pendingToolUseId;
    const now = Date.now();

    const attempt = await ctx.db
      .query("attempts")
      .withIndex("by_design_preset", (q) => q.eq("designId", design._id).eq("presetId", args.presetId))
      .first();
    if (attempt) {
      await ctx.db.patch(attempt._id, { features: args.features, distance: args.diff ? args.diff.distance : null });
    }
    await ctx.db.patch(design._id, {
      pendingToolUseId: null,
      pendingPresetId: null,
      renderOwnerClientId: null,
      renderLeaseUntil: 0,
    });

    await appendMessage(ctx, design._id, {
      role: "user",
      content: [
        analysisToolResult({
          toolUseId,
          features: args.features,
          diff: args.diff,
          iteration: design.iteration,
          iterationsRemaining: iterationsRemaining(design),
          bestDistance: await bestDistance(ctx, design._id),
        }),
      ],
    });
    await beginDesignTurn(ctx, design, now);
    return { accepted: true };
  },
});

export const submitRenderError = mutation({
  args: { designId: v.id("designs"), clientId: v.string(), presetId: v.string(), message: v.string() },
  returns: vResult,
  handler: async (ctx, args) => {
    const design = await ctx.db.get(args.designId);
    if (!design) return { accepted: false, reason: "no such design" };
    if (design.status !== "awaiting_render" || !design.pendingToolUseId) {
      return { accepted: false, reason: `Design is "${design.status}", not awaiting a render.` };
    }
    if (args.presetId !== design.pendingPresetId) return { accepted: false, reason: "stale preset" };
    const toolUseId = design.pendingToolUseId;

    await ctx.db.patch(design._id, {
      pendingToolUseId: null,
      pendingPresetId: null,
      renderOwnerClientId: null,
      renderLeaseUntil: 0,
    });
    await appendMessage(ctx, design._id, {
      role: "user",
      content: [
        renderErrorToolResult({ toolUseId, message: args.message, iterationsRemaining: iterationsRemaining(design) }),
      ],
    });
    await beginDesignTurn(ctx, design, Date.now());
    return { accepted: true };
  },
});

/**
 * Claim the pending render. First caller wins; the loser gets {granted:false}.
 * Serializable mutations order concurrent claims, so no client election.
 */
export const claimRender = mutation({
  args: { designId: v.id("designs"), clientId: v.string(), presetId: v.string() },
  returns: v.object({ granted: v.boolean(), attemptNo: v.number() }),
  handler: async (ctx, args) => {
    const design = await ctx.db.get(args.designId);
    if (!design) return { granted: false, attemptNo: 0 };
    const now = Date.now();
    if (design.status !== "awaiting_render" || design.pendingPresetId !== args.presetId) {
      return { granted: false, attemptNo: design.renderAttemptNo };
    }
    const live = now < design.renderLeaseUntil;
    if (design.renderOwnerClientId === args.clientId && live) return { granted: true, attemptNo: design.renderAttemptNo };
    if (design.renderOwnerClientId !== null && live) return { granted: false, attemptNo: design.renderAttemptNo };

    const attemptNo = design.renderAttemptNo + 1;
    await grantRender(ctx, design, args.clientId, now, attemptNo, args.presetId);
    return { granted: true, attemptNo };
  },
});

/**
 * The lease backstop. Fenced on {presetId, attemptNo} because nothing reliably
 * cancels an earlier job: one armed for preset P must do nothing during Q's lease.
 */
export const leaseExpired = internalMutation({
  args: { designId: v.id("designs"), presetId: v.string(), attemptNo: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const design = await ctx.db.get(args.designId);
    if (!design || design.status !== "awaiting_render") return null;
    if (design.pendingPresetId !== args.presetId) return null; // superseded
    if (design.renderAttemptNo !== args.attemptNo) return null; // claimed or reopened since
    const now = Date.now();
    if (now < design.renderLeaseUntil) return null; // extended
    await reopenOrAbandonRender(ctx, design, now);
    return null;
  },
});
