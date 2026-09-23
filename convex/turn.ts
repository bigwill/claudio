/**
 * The turn's database half: what the action reads before calling Claude, and
 * what it commits afterwards.
 *
 * This is a transliteration of the second half of SessionDO.turn()
 * (src/worker/session.ts:445-561). The branch structure and every tool_result
 * string are deliberately unchanged; what is new is the fencing that makes it
 * safe when the caller is a non-transactional action rather than a
 * single-threaded actor.
 */

import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  addChat,
  beginTurn,
  drainQueue,
  grantRender,
  iterationsRemaining,
  reassignOrAbandonRender,
} from "./model/turn";
import {
  appendMessage,
  finalizeToolResult,
  loadMessages,
  unknownToolResult,
  decodeContent,
} from "./model/messages";
import { readAssistantTurn, readToolInput } from "./model/tools";
import { presentClients } from "./model/presence";

/**
 * Everything the action needs, in ONE read.
 *
 * Returns null when this turn has been superseded — the session moved on while
 * the action was starting, so there is nothing to do. The action must treat null
 * as "stop", not as an error.
 */
export const planForAction = internalQuery({
  args: { sessionId: v.id("sessions"), turnSeq: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      messages: v.any(),
      force: v.boolean(),
      isFirstProposal: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const s = await ctx.db.get(args.sessionId);
    if (!s || s.turnSeq !== args.turnSeq || s.status !== "thinking") return null;
    return {
      messages: await loadMessages(ctx, args.sessionId),
      force: s.turnForce,
      isFirstProposal: s.turnIsFirstProposal,
    };
  },
});

/**
 * Land an assistant turn.
 *
 * The fence on the first line is the entire answer to "actions are not
 * transactional". An action that overran its lease, got reclaimed, and only then
 * returned would otherwise append an assistant turn — possibly containing a
 * tool_use — into a conversation that has already been healed and moved on. The
 * next request would then be rejected outright with
 *   400 `tool_use` ids were found without `tool_result` blocks
 * and the session would be permanently unusable. It also makes this mutation
 * idempotent under the action's own retries, for free.
 */
export const commit = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    turnSeq: v.number(),
    content: v.any(),
    stopReason: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.turnSeq !== args.turnSeq) return null; // FENCE
    const now = Date.now();

    // The action passes the model's content as JSON text: Convex arguments sort
    // object keys the same way stored documents do (see model/messages.ts).
    const content = decodeContent(args.content);
    const { text, call } = readAssistantTurn(content);

    /**
     * Truncation guard, BEFORE anything is persisted.
     *
     * max_tokens covers thinking + prose + the tool_use block together, and
     * thinking is on by default, so a long think can consume the budget and
     * leave no complete tool call. Without this the turn falls through to the
     * text branch and the loop stalls looking like the agent simply chose to
     * chat — a silent, badly mislabelled failure.
     */
    if (args.stopReason === "max_tokens" && !call) {
      await ctx.db.patch(session._id, {
        status: "idle",
        statusSince: now,
        turnSeq: session.turnSeq + 1,
        turnDeadline: 0,
        turnJobId: null,
        lastError: "The agent hit its output limit before finishing a preset.",
        lastErrorRetryable: true,
      });
      await addChat(ctx, session, {
        kind: "system",
        text:
          "The agent hit its output limit before finishing a preset. Retry, or lower the effort " +
          "level if this keeps happening.",
      });
      await drainQueue(ctx, session._id, now);
      return null;
    }

    // Persist the assistant turn VERBATIM — thinking blocks and tool_use blocks
    // included. Editing or dropping them breaks the next turn.
    await appendMessage(ctx, session, { role: "assistant", content });

    // ---- propose_preset: the turn pauses here until a browser reports back ---
    if (call && call.name === "propose_preset") {
      const { preset, rationale } = readToolInput(call.input);
      // The tool_use id IS the presetId: unique per proposal, already the thing
      // being tracked, and it needs no id generation inside a mutation.
      const presetId = call.id;
      const iteration = session.iteration + 1;

      await ctx.db.insert("attempts", {
        sessionId: session._id,
        presetId,
        iteration,
        preset,
        rationale,
        features: null,
        distance: null,
        askedByClientId: session.turnStartedBy,
        measuredByClientId: null,
        isFinal: false,
      });
      if (text || rationale) {
        await addChat(ctx, session, {
          kind: "agent",
          text: text ? `${text}\n\n${rationale}` : rationale,
          aboutPresetId: presetId,
        });
      }

      await ctx.db.patch(session._id, {
        status: "awaiting_render",
        statusSince: now,
        iteration,
        pendingToolUseId: call.id,
        pendingPresetId: presetId,
        turnSeq: session.turnSeq + 1,
        turnDeadline: 0,
        turnJobId: null,
      });

      // Render duty goes to whoever triggered this turn. If they have already
      // gone, hand it straight to someone who is here rather than burning a
      // whole lease discovering that.
      const present = await presentClients(ctx, session._id, now);
      const ownerStillHere = present.some((p) => p.clientId === session.turnStartedBy);
      const owner = ownerStillHere ? session.turnStartedBy : (present[0]?.clientId ?? null);
      await grantRender(ctx, session, owner, now, 1, presetId);

      // NOTE: the queue is deliberately NOT drained here. A render is owed, and
      // queued messages ride along on its tool_result instead (see render.ts) —
      // which is what stops someone's note waiting out the whole refine loop.
      return null;
    }

    // ---- finalize ----------------------------------------------------------
    if (call && call.name === "finalize") {
      const { preset, rationale, suggestions } = readToolInput(call.input);
      const presetId = call.id;

      // MUST close the tool_use in this same transaction. finalize is resolved
      // here and now — no browser is going to answer it — so leaving it dangling
      // means every conversation after a finalize fails. In the Durable Object
      // this and the assistant append were two separate writes a crash could
      // split; here they cannot come apart.
      await appendMessage(ctx, session, {
        role: "user",
        content: [finalizeToolResult(call.id)],
      });

      await ctx.db.insert("attempts", {
        sessionId: session._id,
        presetId,
        iteration: session.iteration,
        preset,
        rationale,
        features: null,
        distance: null,
        askedByClientId: session.turnStartedBy,
        measuredByClientId: null,
        isFinal: true,
      });
      await addChat(ctx, session, {
        kind: "agent",
        text: text ? `${text}\n\n${rationale}` : rationale,
        aboutPresetId: presetId,
        suggestions,
      });

      await ctx.db.patch(session._id, {
        status: "done",
        statusSince: now,
        pendingToolUseId: null,
        pendingPresetId: null,
        renderOwnerClientId: null,
        renderLeaseUntil: 0,
        // Point "best" at what the agent actually committed to. The DO left
        // bestPresetId on the lowest-distance attempt, so a restored session
        // loaded a preset the agent had deliberately passed over — the tool
        // description explicitly allows finalizing an earlier, better-sounding
        // patch over the numerically best one.
        bestPresetId: presetId,
        turnSeq: session.turnSeq + 1,
        turnDeadline: 0,
        turnJobId: null,
      });
      await drainQueue(ctx, session._id, now);
      return null;
    }

    // ---- an unrecognized tool ----------------------------------------------
    // Answer it, or it dangles and breaks the next request the same way an
    // unanswered finalize would. Answering lets the model correct itself.
    if (call) {
      await appendMessage(ctx, session, {
        role: "user",
        content: [unknownToolResult(call.id, call.name)],
      });
    }

    // ---- plain text (only reachable from chat, where tool_choice is "auto") --
    await addChat(ctx, session, { kind: "agent", text: text || "(no response)" });
    await ctx.db.patch(session._id, {
      status: "idle",
      statusSince: now,
      turnSeq: session.turnSeq + 1,
      turnDeadline: 0,
      turnJobId: null,
    });
    await drainQueue(ctx, session._id, now);
    return null;
  },
});

/**
 * The Claude call threw.
 *
 * Never leave status on "thinking" — that wedges the session permanently, which
 * is the failure the DO's catch block existed to prevent. The error also has to
 * be PERSISTED: with no synchronous response to return, an error that isn't
 * written down is indistinguishable from "nothing happened when I pressed send".
 */
export const fail = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    turnSeq: v.number(),
    message: v.string(),
    retryable: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.turnSeq !== args.turnSeq) return null; // FENCE
    const now = Date.now();

    await ctx.db.patch(session._id, {
      status: session.pendingToolUseId ? "awaiting_render" : "idle",
      statusSince: now,
      turnSeq: session.turnSeq + 1,
      turnDeadline: 0,
      turnJobId: null,
      lastError: args.message,
      lastErrorRetryable: args.retryable,
    });
    await addChat(ctx, session, { kind: "system", text: args.message });
    await drainQueue(ctx, session._id, now);
    return null;
  },
});

/**
 * The backstop for turns and renders that died without telling anyone.
 *
 * Both halves are needed. `thinking` covers an action that crashed, timed out, or
 * was killed by a deploy. `awaiting_render` covers a lease whose one-shot
 * `leaseExpired` job failed — scheduled mutations are only retried on transient
 * errors, so without a periodic sweep that state has no recovery path at all.
 *
 * Deliberately NOT consulting _scheduled_functions to ask whether the job is
 * still alive: that read set includes documents the scheduler itself writes on
 * every state transition, which is the textbook OCC-conflict shape, and
 * "extend while in progress" would let a genuinely hung action pin a session
 * indefinitely — strictly worse than the deadline it replaced. The SDK timeout in
 * agent.ts is what bounds a slow call; this just cleans up after it.
 */
export const watchdog = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    const stuckTurns = await ctx.db
      .query("sessions")
      .withIndex("by_status_deadline", (q) =>
        q.eq("status", "thinking").lt("turnDeadline", now),
      )
      .take(25);

    for (const s of stuckTurns) {
      await ctx.db.patch(s._id, {
        status: s.pendingToolUseId ? "awaiting_render" : "idle",
        statusSince: now,
        turnSeq: s.turnSeq + 1, // fence the presumed-dead action out
        turnDeadline: 0,
        turnJobId: null,
        lastError: "That turn stopped responding and was reclaimed.",
        lastErrorRetryable: true,
      });
      await addChat(ctx, s, {
        kind: "system",
        text: "That turn stopped responding and was reclaimed — try again.",
      });
      await drainQueue(ctx, s._id, now);
    }

    const stuckRenders = await ctx.db
      .query("sessions")
      .withIndex("by_render_lease", (q) =>
        q.eq("status", "awaiting_render").lt("renderLeaseUntil", now),
      )
      .take(25);

    for (const s of stuckRenders) {
      await reassignOrAbandonRender(ctx, s as Doc<"sessions">, now);
    }
    return null;
  },
});
