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
import { designNote, openRenderWindow, reopenOrAbandonRender } from "./model/design";
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

    // Truncation guard, BEFORE anything is persisted: thinking can consume the
    // budget and leave no complete tool call.
    if (args.stopReason === "max_tokens" && !call) {
      await ctx.db.patch(design._id, {
        status: "failed",
        turnSeq: design.turnSeq + 1,
        turnDeadline: 0,
        lastError: "The designer hit its output limit before finishing a preset.",
      });
      await designNote(ctx, design, "The sound design stopped: the designer hit its output limit.");
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
      await ctx.db.insert("attempts", {
        designId: design._id,
        presetId: call.id,
        iteration: design.iteration,
        preset,
        rationale,
        features: null,
        distance: null,
        isFinal: true,
      });
      await ctx.db.patch(design._id, {
        status: "done",
        pendingToolUseId: null,
        pendingPresetId: null,
        renderOwnerClientId: null,
        renderLeaseUntil: 0,
        turnSeq: design.turnSeq + 1,
        turnDeadline: 0,
      });
      // Slice 4's endDesign: library row, design part, free the musician, drain.
      return null;
    }

    // ---- an unrecognized tool: answer it, or it dangles ---------------------
    if (call) {
      await appendMessage(ctx, design._id, { role: "user", content: [unknownToolResult(call.id, call.name)] });
    }

    // ---- no usable tool call. Slice 4 turns this into the two-strike guard. --
    await ctx.db.patch(design._id, {
      status: "failed",
      turnSeq: design.turnSeq + 1,
      turnDeadline: 0,
      noToolStrikes: design.noToolStrikes + 1,
      lastError: "The designer replied without proposing a preset.",
    });
    await designNote(ctx, design, "The sound design stopped: the designer replied without proposing a preset.");
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
    await ctx.db.patch(design._id, {
      status: "failed",
      turnSeq: design.turnSeq + 1,
      turnDeadline: 0,
      lastError: args.message,
    });
    await designNote(ctx, design, `The sound design stopped: ${args.message}`);
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
    for (const d of stuckTurns) {
      await ctx.db.patch(d._id, {
        status: "failed",
        turnSeq: d.turnSeq + 1, // fence the presumed-dead action out
        turnDeadline: 0,
        lastError: "The design turn stopped responding and was reclaimed.",
      });
      await designNote(ctx, d, "The sound design stopped responding and was reclaimed.");
    }

    const stuckRenders = await ctx.db
      .query("designs")
      .withIndex("by_render_lease", (q) => q.eq("status", "awaiting_render").lt("renderLeaseUntil", now))
      .take(25);
    for (const d of stuckRenders) await reopenOrAbandonRender(ctx, d, now);
    return null;
  },
});
