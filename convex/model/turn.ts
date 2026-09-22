/**
 * The turn state machine: starting turns, recovering dead ones, and the queue.
 *
 * SessionDO got mutual exclusion from being single-threaded. Convex gives
 * something stronger for free — serializable mutations — but only for code that
 * actually reads what it depends on. The rule this whole file obeys:
 *
 *   Any mutation whose behaviour depends on session.status must LOAD the session
 *   document. That read is what puts it in the OCC read set, and the read set is
 *   what makes serialization happen.
 *
 * Two clients calling chat.send at once therefore can't both start a turn: both
 * read, both patch, one commits, and Convex transparently re-runs the loser
 * against fresh data, where it sees a busy session and queues instead.
 */

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  MAX_DRAIN_BATCH,
  MAX_RENDER_ATTEMPTS,
  RENDER_LEASE_MS,
  TURN_LEASE_MS,
} from "../../src/shared/protocol";
import { abandonedRenderToolResult, appendMessage, healBlocks, tailMessage } from "./messages";
import { anyonePresent, pickRenderer, presentClients } from "./presence";

type Session = Doc<"sessions">;

export const isTurnLive = (s: Session, now: number): boolean =>
  s.status === "thinking" && now < s.turnDeadline;

/** Busy = something is owed. A turn is running, or a render hasn't come back. */
export const isBusy = (s: Session, now: number): boolean =>
  isTurnLive(s, now) || s.status === "awaiting_render";

export const iterationsRemaining = (s: Session): number =>
  Math.max(0, s.maxIterations - s.iteration);

// ---------------------------------------------------------------------------
// Chat rows
// ---------------------------------------------------------------------------

export async function addChat(
  ctx: MutationCtx,
  session: Session,
  row: {
    kind: "user" | "agent" | "system";
    text: string;
    status?: "queued" | "sent" | "cancelled";
    authorClientId?: string | null;
    nickname?: string | null;
    color?: string | null;
    aboutPresetId?: string | null;
    suggestions?: string[];
  },
): Promise<Id<"chat">> {
  const seq = session.chatSeq;
  const id = await ctx.db.insert("chat", {
    sessionId: session._id,
    seq,
    kind: row.kind,
    status: row.status ?? "sent",
    authorClientId: row.authorClientId ?? null,
    nickname: row.nickname ?? null,
    color: row.color ?? null,
    text: row.text,
    aboutPresetId: row.aboutPresetId ?? null,
    suggestions: row.suggestions ?? [],
  });
  await ctx.db.patch(session._id, { chatSeq: seq + 1 });
  session.chatSeq = seq + 1;
  return id;
}

// ---------------------------------------------------------------------------
// Starting a turn
// ---------------------------------------------------------------------------

/**
 * Flip the session to "thinking" and schedule the action that will talk to
 * Claude. Both writes and the schedule commit together: `ctx.scheduler.runAfter`
 * from a mutation is atomic with the mutation, so "status became thinking" and
 * "the turn is queued" cannot come apart. That guarantee has no Durable Object
 * equivalent and is what makes this design safe.
 */
export async function beginTurn(
  ctx: MutationCtx,
  session: Session,
  opts: { by: string | null; force: boolean; isFirstProposal: boolean; now: number },
): Promise<number> {
  const turnSeq = session.turnSeq + 1;
  const jobId = await ctx.scheduler.runAfter(0, internal.agent.runTurn, {
    sessionId: session._id,
    turnSeq,
  });
  await ctx.db.patch(session._id, {
    status: "thinking",
    statusSince: opts.now,
    turnSeq,
    turnDeadline: opts.now + TURN_LEASE_MS,
    turnStartedBy: opts.by,
    turnForce: opts.force,
    turnIsFirstProposal: opts.isFirstProposal,
    turnJobId: jobId,
    lastError: null,
    lastErrorRetryable: false,
  });
  session.turnSeq = turnSeq;
  session.status = "thinking";
  return turnSeq;
}

/**
 * If a turn has outlived its lease, take the session back.
 *
 * Bumping turnSeq is the important half: it fences out the action that is
 * presumably still running, so if it ever does return, its commit no-ops rather
 * than appending a tool_use into a log that has moved on. (That is precisely how
 * you would manufacture the "tool_use ids were found without tool_result blocks"
 * 400 that bricks a conversation.)
 *
 * Returns the session as it now stands, so callers keep working from fresh state.
 */
export async function reclaimIfStale(
  ctx: MutationCtx,
  session: Session,
  now: number,
): Promise<Session> {
  if (session.status !== "thinking" || now < session.turnDeadline) return session;

  // Restore to whatever the session was actually in the middle of. Unlike the
  // DO's version of this line, pendingToolUseId here can genuinely be set: a
  // turn started from submitAnalysis has already published a render.
  const restored = session.pendingToolUseId ? "awaiting_render" : "idle";
  await ctx.db.patch(session._id, {
    status: restored,
    statusSince: now,
    turnSeq: session.turnSeq + 1,
    turnDeadline: 0,
    turnJobId: null,
    lastError: "That turn stopped responding and was reclaimed.",
    lastErrorRetryable: true,
  });
  await addChat(ctx, session, {
    kind: "system",
    text: "That turn stopped responding and was reclaimed — try again.",
  });
  return (await ctx.db.get(session._id))!;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export async function queuedRows(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"chat">[]> {
  return await ctx.db
    .query("chat")
    .withIndex("by_session_status_seq", (q) =>
      q.eq("sessionId", sessionId).eq("status", "queued"),
    )
    .order("asc")
    .take(MAX_DRAIN_BATCH);
}

/**
 * One person's queued message, as a prompt block.
 *
 * The name prefix is how the model tells speakers apart, and it is why nicknames
 * are sanitized server-side: a name containing a bracket could otherwise forge a
 * speaker. `aboutPresetId` context is included because a queued message can be
 * minutes stale by the time it is read — "darker" means something different if
 * the patch it was aimed at has since been replaced.
 */
async function presetName(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  presetId: string | null,
): Promise<string | null> {
  if (!presetId) return null;
  const attempt = await ctx.db
    .query("attempts")
    .withIndex("by_session_preset", (q) =>
      q.eq("sessionId", sessionId).eq("presetId", presetId),
    )
    .first();
  return attempt?.preset.name ?? null;
}

async function queuedBlock(
  ctx: MutationCtx,
  row: Doc<"chat">,
): Promise<{ type: "text"; text: string }> {
  const who = row.nickname ?? "someone";
  const name = await presetName(ctx, row.sessionId, row.aboutPresetId);
  const about = name ? `, about "${name}"` : "";
  return { type: "text", text: `[${who}${about}] ${row.text}` };
}

/**
 * Take queued messages so they can ride along on a user turn that is already
 * being built — specifically, the one carrying a render's tool_result.
 *
 * This is the difference between "your note is read on the next turn" and "your
 * note waits out the entire refine loop". A tool_result block followed by text
 * blocks in the same user turn is legal and strands nothing, so there is no
 * reason to make people queue behind three iterations and a finalize.
 */
export async function takeQueuedBlocks(
  ctx: MutationCtx,
  session: Session,
): Promise<{ blocks: { type: "text"; text: string }[]; rows: Doc<"chat">[] }> {
  const rows = await queuedRows(ctx, session._id);
  const blocks: { type: "text"; text: string }[] = [];
  for (const row of rows) {
    blocks.push(await queuedBlock(ctx, row));
    await ctx.db.patch(row._id, { status: "sent" });
  }
  return { blocks, rows };
}

/**
 * Start a turn for whatever is queued, if anything, and if anyone is here.
 *
 * The presence check is not politeness — it is the cost backstop. Without it an
 * abandoned session with queued messages would sit there running full Opus turns
 * against an empty room, because nothing else in this design requires a human to
 * be present for the loop to advance. Under the old Worker the backpressure was
 * implicit: the loop could not proceed without a browser doing the render.
 */
export async function drainQueue(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  now: number,
): Promise<void> {
  const session = await ctx.db.get(sessionId);
  if (!session) return;
  if (isBusy(session, now)) return;
  if (!(await anyonePresent(ctx, sessionId, now))) return;

  const { blocks, rows } = await takeQueuedBlocks(ctx, session);
  if (rows.length === 0) return;

  // Heal first: if the tail is an unanswered tool_use, its tool_result must lead
  // the user turn we are about to append.
  const tail = await tailMessage(ctx, sessionId);
  await appendMessage(ctx, session, {
    role: "user",
    content: [...healBlocks(tail), ...blocks],
  });

  // Render duty follows whoever spoke first in the batch.
  await beginTurn(ctx, session, {
    by: rows[0].authorClientId,
    force: false,
    isFirstProposal: false,
    now,
  });
}

// ---------------------------------------------------------------------------
// Render duty
// ---------------------------------------------------------------------------

/**
 * Hand a pending render to a client and arm the lease backstop.
 *
 * The scheduled job carries {presetId, attemptNo} and re-checks them, because
 * nothing cancels the previous one reliably — `scheduler.cancel` only stops a job
 * that has not started. Without those arguments a job armed for preset P would
 * fire during preset Q's live lease and close Q's tool_use, burning an iteration
 * and telling the model a render failed that hadn't.
 */
export async function grantRender(
  ctx: MutationCtx,
  session: Session,
  clientId: string | null,
  now: number,
  attemptNo: number,
  // Passed explicitly rather than read off the session: commit() grants a render
  // in the same transaction that first sets pendingPresetId, so reading it back
  // off a stale in-memory copy would arm the backstop for the wrong preset.
  presetId: string,
): Promise<void> {
  await ctx.db.patch(session._id, {
    renderOwnerClientId: clientId,
    renderLeaseUntil: now + RENDER_LEASE_MS,
    renderAttemptNo: attemptNo,
  });
  await ctx.scheduler.runAfter(RENDER_LEASE_MS + 1_000, internal.render.leaseExpired, {
    sessionId: session._id,
    presetId,
    attemptNo,
  });
}

/**
 * Give up on a render and answer its tool_use, so the conversation stays usable.
 *
 * An unanswered tool_use is fatal to every later request, so "nobody rendered it"
 * must still produce a tool_result. The session returns to idle and the queue
 * gets its chance.
 */
export async function abandonRender(
  ctx: MutationCtx,
  session: Session,
  why: string,
  now: number,
): Promise<void> {
  if (session.pendingToolUseId) {
    await appendMessage(ctx, session, {
      role: "user",
      content: [abandonedRenderToolResult(session.pendingToolUseId, why)],
    });
  }
  await ctx.db.patch(session._id, {
    status: "idle",
    statusSince: now,
    pendingToolUseId: null,
    pendingPresetId: null,
    renderOwnerClientId: null,
    renderLeaseUntil: 0,
    lastError: `That render was never completed (${why}).`,
    lastErrorRetryable: true,
  });
  await addChat(ctx, session, {
    kind: "system",
    text: `That render was never completed (${why}).`,
  });
  await drainQueue(ctx, session._id, now);
}

/**
 * Lease ran out. Decide whether to re-grant it, and to whom.
 *
 * The case that matters most is the least dramatic one: the owner is still here
 * but stuck — a backgrounded tab, a hung Tone context, a submit that keeps
 * failing — with nobody else around. That is the ordinary solo failure, and if
 * this only handled "hand it to someone else" or "everyone left", it would wedge.
 * So the owner gets re-granted too, until the attempts run out.
 */
export async function reassignOrAbandonRender(
  ctx: MutationCtx,
  session: Session,
  now: number,
): Promise<void> {
  const present = await presentClients(ctx, session._id, now);
  const nextAttempt = session.renderAttemptNo + 1;

  if (present.length === 0) {
    await abandonRender(ctx, session, "everyone left the session", now);
    return;
  }
  if (nextAttempt > MAX_RENDER_ATTEMPTS) {
    await abandonRender(ctx, session, "no browser could complete it", now);
    return;
  }

  // Prefer someone other than the owner who just failed us; fall back to the
  // owner (or anyone) rather than stalling.
  const taker =
    pickRenderer(present, now, session.renderOwnerClientId) ??
    pickRenderer(present, now, null);
  if (!taker) {
    await abandonRender(ctx, session, "no browser could complete it", now);
    return;
  }

  await grantRender(ctx, session, taker.clientId, now, nextAttempt, session.pendingPresetId!);
  await addChat(ctx, session, {
    kind: "system",
    text: `${taker.nickname} picked up the render.`,
  });
}
