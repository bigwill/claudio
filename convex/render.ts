/**
 * Measurements coming back from a browser, and who is on the hook to produce them.
 *
 * The idempotency story is ported intact from SessionDO.requirePending: a
 * submission is accepted only when the session is actually awaiting a render AND
 * the presetId matches the pending one. A double-click, a retry, or two browsers
 * racing therefore cannot desync the conversation — the first to commit flips the
 * status, and the second fails that check.
 *
 * What changed is the RETURN SHAPE, not the logic. The DO threw a ProtocolError
 * and the Worker mapped it to a 409 the client displayed. Convex redacts thrown
 * errors before they reach the browser and logs them as deployment errors, so
 * throwing here would put red text in every subscriber's console for something
 * that is completely normal traffic — losing a render race is expected, not
 * exceptional. Hence {accepted, reason}.
 */

import { v } from "convex/values";

import { internalMutation, mutation } from "./_generated/server";
import { vFeatureDiff, vFeatureSummary } from "./validators";
import {
  beginTurn,
  grantRender,
  iterationsRemaining,
  reassignOrAbandonRender,
  takeQueuedBlocks,
} from "./model/turn";
import { analysisToolResult, appendMessage, renderErrorToolResult } from "./model/messages";
import { presentClients } from "./model/presence";
import { bySlug } from "./model/sessions";
import { RENDER_LEASE_MS } from "../src/shared/protocol";

const vResult = v.object({ accepted: v.boolean(), reason: v.optional(v.string()) });

export const submitAnalysis = mutation({
  args: {
    slug: v.string(),
    clientId: v.string(),
    presetId: v.string(),
    features: vFeatureSummary,
    // Explicitly nullable, never optional: prompt-started sessions have no
    // target to diff against, and Convex stores an absent key as undefined —
    // which would not survive the `diff ? … : …` branches downstream.
    diff: v.union(v.null(), vFeatureDiff),
  },
  returns: vResult,
  handler: async (ctx, args) => {
    const session = await bySlug(ctx, args.slug);
    if (!session) return { accepted: false, reason: "no such session" };
    const now = Date.now();

    // --- requirePending, verbatim in spirit ---------------------------------
    if (session.status !== "awaiting_render" || !session.pendingToolUseId) {
      return {
        accepted: false,
        reason: `Session is "${session.status}", not awaiting a render — nothing to submit.`,
      };
    }
    if (args.presetId !== session.pendingPresetId) {
      return {
        accepted: false,
        reason: `Stale preset: expected "${session.pendingPresetId}", got "${args.presetId}".`,
      };
    }
    const toolUseId = session.pendingToolUseId;

    // NOTE: deliberately no render-OWNER check. Every contributor renders against
    // the session's pinned renderSpec, so two measurements of the same preset are
    // equivalent — rejecting one because the lease flapped would throw away a
    // perfectly good measurement for no safety gain.

    const attempt = await ctx.db
      .query("attempts")
      .withIndex("by_session_preset", (q) =>
        q.eq("sessionId", session._id).eq("presetId", args.presetId),
      )
      .first();
    if (attempt) {
      await ctx.db.patch(attempt._id, {
        features: args.features,
        distance: args.diff ? args.diff.distance : null,
        measuredByClientId: args.clientId,
      });
    }

    const patch: Record<string, unknown> = {
      pendingToolUseId: null,
      pendingPresetId: null,
      renderOwnerClientId: null,
      renderLeaseUntil: 0,
    };
    if (args.diff && (session.bestDistance === null || args.diff.distance < session.bestDistance)) {
      patch.bestDistance = args.diff.distance;
      patch.bestPresetId = args.presetId;
    }
    // Prompt-started sessions have no distance, so "best" is simply the latest.
    if (!args.diff) patch.bestPresetId = args.presetId;
    await ctx.db.patch(session._id, patch);

    /**
     * Queued messages ride along on this tool_result.
     *
     * A tool_result block followed by text blocks in the same user turn is legal
     * and strands nothing, so there is no reason to make someone's "make it
     * darker" wait out two more iterations and a finalize. This is the single
     * change that keeps a three-person session feeling like a conversation
     * rather than a ticket queue.
     */
    const { blocks } = await takeQueuedBlocks(ctx, session);

    await appendMessage(ctx, session, {
      role: "user",
      content: [
        analysisToolResult({
          toolUseId,
          features: args.features,
          diff: args.diff,
          iteration: session.iteration,
          iterationsRemaining: iterationsRemaining(session),
          bestDistance: (patch.bestDistance as number | undefined) ?? session.bestDistance,
        }),
        ...blocks,
      ],
    });

    // Render duty follows the measurer: they are mid-loop, their browser is warm,
    // and keeping one browser through the refine loop keeps the measurements
    // maximally comparable.
    await beginTurn(ctx, session, {
      by: args.clientId,
      force: true,
      isFirstProposal: false,
      now,
    });
    return { accepted: true };
  },
});

export const submitRenderError = mutation({
  args: {
    slug: v.string(),
    clientId: v.string(),
    presetId: v.string(),
    message: v.string(),
  },
  returns: vResult,
  handler: async (ctx, args) => {
    const session = await bySlug(ctx, args.slug);
    if (!session) return { accepted: false, reason: "no such session" };
    const now = Date.now();

    if (session.status !== "awaiting_render" || !session.pendingToolUseId) {
      return { accepted: false, reason: `Session is "${session.status}", not awaiting a render.` };
    }
    if (args.presetId !== session.pendingPresetId) {
      return { accepted: false, reason: "stale preset" };
    }
    const toolUseId = session.pendingToolUseId;

    await ctx.db.patch(session._id, {
      pendingToolUseId: null,
      pendingPresetId: null,
      renderOwnerClientId: null,
      renderLeaseUntil: 0,
    });

    const { blocks } = await takeQueuedBlocks(ctx, session);
    await appendMessage(ctx, session, {
      role: "user",
      content: [
        renderErrorToolResult({
          toolUseId,
          message: args.message,
          iterationsRemaining: iterationsRemaining(session),
        }),
        ...blocks,
      ],
    });

    await beginTurn(ctx, session, {
      by: args.clientId,
      force: true,
      isFirstProposal: false,
      now,
    });
    return { accepted: true };
  },
});

/**
 * Take over a render whose lease has lapsed.
 *
 * There is deliberately no client-side election in front of this. The attempt
 * counter plus Convex's serializable mutations already order concurrent claims —
 * the loser simply gets {granted:false} — and rooms are two to five people, so
 * there is no herd to thin. A server that re-validated an election would also
 * deadlock takeover whenever a claimant's presence view was stale, which is
 * exactly the moment takeover matters.
 */
export const claimRender = mutation({
  args: { slug: v.string(), clientId: v.string(), presetId: v.string() },
  returns: v.object({ granted: v.boolean(), attemptNo: v.number() }),
  handler: async (ctx, args) => {
    const session = await bySlug(ctx, args.slug);
    if (!session) return { granted: false, attemptNo: 0 };
    const now = Date.now();

    if (session.status !== "awaiting_render" || session.pendingPresetId !== args.presetId) {
      return { granted: false, attemptNo: session?.renderAttemptNo ?? 0 };
    }
    // Already yours, and still live — nothing to do.
    if (session.renderOwnerClientId === args.clientId && now < session.renderLeaseUntil) {
      return { granted: true, attemptNo: session.renderAttemptNo };
    }
    // Someone else still holds a live lease.
    if (session.renderOwnerClientId !== null && now < session.renderLeaseUntil) {
      return { granted: false, attemptNo: session.renderAttemptNo };
    }

    const attemptNo = session.renderAttemptNo + 1;
    await grantRender(ctx, session, args.clientId, now, attemptNo, args.presetId);
    return { granted: true, attemptNo };
  },
});

/**
 * The lease backstop, armed whenever a render is granted.
 *
 * It fences on {presetId, attemptNo} because nothing reliably cancels the
 * previous job — `scheduler.cancel` only stops one that has not started yet. A
 * job armed for preset P must therefore be able to recognise that it is firing
 * during preset Q's live lease and do nothing; otherwise it would close Q's
 * tool_use, burn an iteration, and tell the model a render had failed that
 * hadn't.
 */
export const leaseExpired = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    presetId: v.string(),
    attemptNo: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    if (session.status !== "awaiting_render") return null;
    if (session.pendingPresetId !== args.presetId) return null; // superseded
    if (session.renderAttemptNo !== args.attemptNo) return null; // re-granted since
    const now = Date.now();
    if (now < session.renderLeaseUntil) return null; // extended

    await reassignOrAbandonRender(ctx, session, now);
    return null;
  },
});

/**
 * A contributor's tab is closing while they hold a live render.
 *
 * `presence.leave` is a WRITE, so every subscriber hears about it immediately —
 * which makes this the fast path that keeps a closed tab from costing everyone a
 * full lease of dead air in a loop that only lasts a minute.
 */
export const releaseOnLeave = internalMutation({
  args: { sessionId: v.id("sessions"), clientId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    if (session.status !== "awaiting_render") return null;
    if (session.renderOwnerClientId !== args.clientId) return null;

    const now = Date.now();
    const present = await presentClients(ctx, session._id, now);
    if (present.length === 0) {
      // Leave it to the lease/watchdog rather than abandoning instantly — the
      // last tab closing is often a reload, and the session should survive one.
      await ctx.db.patch(session._id, { renderLeaseUntil: now + RENDER_LEASE_MS });
      return null;
    }
    await reassignOrAbandonRender(ctx, session, now);
    return null;
  },
});
