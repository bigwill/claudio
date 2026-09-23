/**
 * A design turn's database half: what the action reads before calling Claude,
 * and what it commits afterwards (plan §4 "Design jobs").
 *
 * Ported from the Worker-era SessionDO.turn(), re-keyed onto `designs`. The
 * branch structure and every tool_result string are unchanged; the fencing on
 * `turnSeq` is what makes it safe when the caller is a non-transactional action.
 */

import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { beginDesignTurn, endDesign, openRenderWindow, reopenOrAbandonRender } from "./model/design";

/** The no-tool guard's nudge (plan §4). */
export const NO_TOOL_NUDGE = "Call propose_preset or finalize now.";
import { appendMessage, decodeContent, finalizeToolResult, loadMessages, unknownToolResult } from "./model/messages";
import { readAssistantTurn, readToolInput } from "./model/tools";

/**
 * Everything the action needs, in ONE read. Null when this turn has been
 * superseded: the action must treat null as "stop", not as an error.
 */
export const planForAction = internalQuery({
  args: { designId: v.id("designs"), turnSeq: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      /**
       * The log as JSON text. A query's return value reaches the action through
       * Convex's value encoding, which sorts object keys; as an object, the
       * model's own earlier tool calls would be sent back to it reordered.
       */
      messagesJson: v.string(),
      force: v.boolean(),
      isFirstProposal: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.designId);
    if (!d || d.turnSeq !== args.turnSeq || d.status !== "thinking") return null;
    return {
      messagesJson: JSON.stringify(await loadMessages(ctx, args.designId)),
      // Every design turn must call a tool (plan §4).
      force: true,
      isFirstProposal: d.iteration === 0,
    };
  },
});

/**
 * Land an assistant turn. The fence on the first line keeps an action that
 * overran its lease from appending a tool_use into a log that has moved on
 * (the "tool_use ids were found without tool_result blocks" 400).
 */
export const commit = internalMutation({
  args: {
    designId: v.id("designs"),
    turnSeq: v.number(),
    /** The model's content as JSON text: Convex arguments sort object keys. */
    content: v.string(),
    stopReason: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const design = await ctx.db.get(args.designId);
    if (!design || design.turnSeq !== args.turnSeq || design.status !== "thinking") return null; // FENCE
    const now = Date.now();

    const content = decodeContent(args.content);
    const { call } = readAssistantTurn(content);

    // Guards, BEFORE anything is persisted (plan §4): a refusal or a turn cut
    // off by max_tokens saves nothing and ends the design. A reasoning_extraction
    // refusal in particular must not be retried.
    if (args.stopReason === "refusal") {
      await endDesign(ctx, design, { kind: "failed", why: "the designer declined this one" });
      return null;
    }
    if (args.stopReason === "max_tokens" && !call) {
      await endDesign(ctx, design, { kind: "failed", why: "the designer hit its output limit" });
      return null;
    }

    // Persist the assistant turn exactly as returned; editing it breaks the next turn.
    await appendMessage(ctx, design._id, { role: "assistant", content });

    // ---- propose_preset: the turn pauses until a browser reports back ------
    if (call && call.name === "propose_preset") {
      const { preset, rationale } = readToolInput(call.input);
      const presetId = call.id; // the tool_use id IS the presetId
      const iteration = design.iteration + 1;
      await ctx.db.insert("attempts", {
        designId: design._id,
        presetId,
        iteration,
        preset,
        rationale,
        features: null,
        distance: null,
        isFinal: false,
      });
      await ctx.db.patch(design._id, {
        status: "awaiting_render",
        iteration,
        pendingToolUseId: call.id,
        pendingPresetId: presetId,
        turnSeq: design.turnSeq + 1,
        turnDeadline: 0,
      });
      await openRenderWindow(ctx, design, now, 0, presetId);
      return null;
    }

    // ---- finalize: MUST close the tool_use in this same transaction ---------
    if (call && call.name === "finalize") {
      const { preset, rationale } = readToolInput(call.input);
      await appendMessage(ctx, design._id, { role: "user", content: [finalizeToolResult(call.id)] });
      const attemptId = await ctx.db.insert("attempts", {
        designId: design._id,
        presetId: call.id,
        iteration: design.iteration,
        preset,
        rationale,
        features: null,
        distance: null,
        isFinal: true,
      });
      await endDesign(ctx, design, { kind: "done", attempt: (await ctx.db.get(attemptId))! });
      return null;
    }

    // ---- an unrecognized tool: answer it, or it dangles ---------------------
    if (call) {
      await appendMessage(ctx, design._id, { role: "user", content: [unknownToolResult(call.id, call.name)] });
    }

    // ---- no-tool guard (plan §4): the turn is saved as returned above; nudge
    // and go again, and on the second strike end the design.
    const strikes = design.noToolStrikes + 1;
    await ctx.db.patch(design._id, { noToolStrikes: strikes });
    if (strikes >= 2) {
      await endDesign(ctx, design, { kind: "failed", why: "the designer twice replied without proposing a preset" });
      return null;
    }
    await appendMessage(ctx, design._id, { role: "user", content: [{ type: "text", text: NO_TOOL_NUDGE }] });
    await beginDesignTurn(ctx, design, now);
    return null;
  },
});

/**
 * The Claude call threw. Never leave status on "thinking", and persist why:
 * with no synchronous response, an unwritten error looks like nothing happened.
 */
export const fail = internalMutation({
  args: { designId: v.id("designs"), turnSeq: v.number(), message: v.string(), retryable: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const design = await ctx.db.get(args.designId);
    if (!design || design.turnSeq !== args.turnSeq) return null; // FENCE
    await endDesign(ctx, design, { kind: "failed", why: args.message });
    return null;
  },
});

/**
 * The backstop for design turns and renders that died without telling anyone.
 * `thinking` covers a crashed or killed action; `awaiting_render` covers a
 * lease whose one-shot leaseExpired job failed. Band turns join in slice 5.
 */
export const watchdog = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const stuckTurns = await ctx.db
      .query("designs")
      .withIndex("by_status_deadline", (q) => q.eq("status", "thinking").lt("turnDeadline", now))
      .take(25);
    // endDesign bumps turnSeq, which fences the presumed-dead action out.
    for (const d of stuckTurns) await endDesign(ctx, d, { kind: "failed", why: "the designer stopped responding" });

    const stuckRenders = await ctx.db
      .query("designs")
      .withIndex("by_render_lease", (q) => q.eq("status", "awaiting_render").lt("renderLeaseUntil", now))
      .take(25);
    for (const d of stuckRenders) await reopenOrAbandonRender(ctx, d, now);
    return null;
  },
});
