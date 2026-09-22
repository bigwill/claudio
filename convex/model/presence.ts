/**
 * Who is in a session right now, and who should be asked to do work.
 *
 * Presence is deliberately cheap and deliberately isolated: a heartbeat touches
 * only this table. If it read the session document, that read would join the
 * OCC conflict domain of every live turn commit, and a 10-second heartbeat per
 * contributor would start losing races with the loop itself.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { PRESENCE_TTL_MS } from "../../src/shared/protocol";

export async function presentClients(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  now: number,
): Promise<Doc<"presence">[]> {
  const rows = await ctx.db
    .query("presence")
    .withIndex("by_session_lastSeen", (q) =>
      q.eq("sessionId", sessionId).gt("lastSeen", now - PRESENCE_TTL_MS),
    )
    .collect();
  return rows;
}

export async function anyonePresent(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  now: number,
): Promise<boolean> {
  const rows = await presentClients(ctx, sessionId, now);
  return rows.length > 0;
}

/**
 * Choose who renders next.
 *
 * Prefers a contributor who is NOT playing. `Tone.Offline` swaps the global Tone
 * context while it runs, so drafting someone as renderer cuts their sound off
 * mid-phrase — whereas a silent lurker loses nothing, and needs no audio gesture
 * for an offline render to work. Among equals, earliest joiner wins so the choice
 * is stable rather than arbitrary.
 */
export function pickRenderer(
  present: Doc<"presence">[],
  now: number,
  exclude: string | null,
): Doc<"presence"> | null {
  const candidates = present.filter((p) => p.clientId !== exclude);
  if (candidates.length === 0) return null;
  const idle = candidates.filter((p) => p.playingUntil <= now);
  const pool = idle.length > 0 ? idle : candidates;
  return pool.reduce((best, p) => (p.joinedAt < best.joinedAt ? p : best));
}

/** Housekeeping so an old session's presence rows don't accumulate forever. */
export async function sweepStalePresence(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  now: number,
): Promise<void> {
  const dead = await ctx.db
    .query("presence")
    .withIndex("by_session_lastSeen", (q) =>
      q.eq("sessionId", sessionId).lte("lastSeen", now - PRESENCE_TTL_MS * 8),
    )
    .take(20);
  for (const row of dead) await ctx.db.delete(row._id);
}
