/**
 * Session lookup and the shape of a brand-new one.
 *
 * Sessions are addressed by `slug` — the 12-char id in the URL — rather than by
 * Convex id, because the slug is what a browser has before it has ever talked to
 * the server. It is minted client-side so the URL is correct before any round
 * trip, and it is explicitly NOT a credential: anyone with the link has the
 * session, which now means anyone with the link can drive the agent.
 */

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_ITERATIONS } from "../../src/shared/protocol";

export async function bySlug(
  ctx: QueryCtx,
  slug: string,
): Promise<Doc<"sessions"> | null> {
  return await ctx.db
    .query("sessions")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .first();
}

/** Everything a session starts life with. Mirrors SessionDO's freshMeta(). */
export function freshSessionFields(slug: string, now: number) {
  return {
    slug,
    status: "idle" as const,
    statusSince: now,
    target: null,
    targetInfo: null,
    targetAudioId: null,
    promptText: null,
    iteration: 0,
    maxIterations: MAX_ITERATIONS,
    bestPresetId: null,
    bestDistance: null,
    pendingToolUseId: null,
    pendingPresetId: null,
    renderSpec: null,
    turnSeq: 0,
    turnDeadline: 0,
    turnStartedBy: null,
    turnForce: false,
    turnIsFirstProposal: false,
    turnJobId: null,
    renderOwnerClientId: null,
    renderLeaseUntil: 0,
    renderAttemptNo: 0,
    msgSeq: 0,
    chatSeq: 0,
    lastError: null,
    lastErrorRetryable: false,
  };
}

/**
 * Has this session already been started?
 *
 * Guarding on "has a target or attempts" is not enough: a prompt-started session
 * never has a target, and its attempts only appear once the first turn commits —
 * so during the window between startFromPrompt and that commit, the guard would
 * be vacuous and a second person clicking a starter chip would wipe the first
 * turn's user message out from under a running action.
 */
export async function isStarted(
  ctx: QueryCtx,
  session: Doc<"sessions">,
): Promise<boolean> {
  if (session.status !== "idle") return true;
  if (session.target !== null || session.promptText !== null) return true;
  const anyMessage = await ctx.db
    .query("messages")
    .withIndex("by_session_seq", (q) => q.eq("sessionId", session._id))
    .first();
  return anyMessage !== null;
}

/** Wipe a session's conversation. Only ever legal on a session nobody has started. */
export async function clearSessionContent(
  ctx: MutationCtx,
  session: Doc<"sessions">,
): Promise<void> {
  for (const table of ["messages", "attempts", "chat"] as const) {
    const rows = await ctx.db
      .query(table)
      .filter((q) => q.eq(q.field("sessionId"), session._id))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}
