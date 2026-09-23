/**
 * The design loop's state machine (plan §4 "Design jobs"), re-keyed from the
 * old per-session loop onto `designs`. One musician owns a design; notes to that
 * musician are held in the band inbox while it runs (activeDesignId), rather
 * than riding along on the render's tool_result as the multiplayer loop did.
 *
 * Render ownership is first-caller-wins (claimRender), fenced by
 * renderAttemptNo. A proposal opens a claim window; a window or lease that
 * lapses reopens until MAX_RENDER_ATTEMPTS, then the render is abandoned.
 *
 * Rule this file obeys: any mutation whose behaviour depends on design.status
 * LOADS the design document, which puts it in the OCC read set.
 *
 * Slice 4 adds designs.start, endDesign (library row + design part), the
 * no-tool guard and the held-inbox drain on top of this.
 */

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { MAX_ITERATIONS, MAX_RENDER_ATTEMPTS, RENDER_LEASE_MS, TURN_LEASE_MS } from "../../src/shared/protocol";
import { postChat } from "./chat";
import { abandonedRenderToolResult, appendMessage } from "./messages";

export type Design = Doc<"designs">;

export const iterationsRemaining = (d: Design): number => Math.max(0, MAX_ITERATIONS - d.iteration);

/** Lowest measured distance so far, for the tool_result's best_distance_so_far. */
export async function bestDistance(ctx: QueryCtx, designId: Id<"designs">): Promise<number | null> {
  const attempts = await ctx.db
    .query("attempts")
    .withIndex("by_design_iteration", (q) => q.eq("designId", designId))
    .take(50);
  const ds = attempts.map((a) => a.distance).filter((d): d is number => d !== null);
  return ds.length ? Math.min(...ds) : null;
}

/** A system row in the band chat, addressed to the design's musician. */
export async function designNote(ctx: MutationCtx, design: Design, text: string): Promise<void> {
  const m = await ctx.db.get(design.musicianId);
  if (!m) return;
  await postChat(ctx, m.jamId, { kind: "system", text, to: [m._id] });
}

/**
 * Flip the design to "thinking" and schedule the Claude call, atomically:
 * `ctx.scheduler.runAfter` from a mutation commits with it.
 */
export async function beginDesignTurn(ctx: MutationCtx, design: Design, now: number): Promise<number> {
  const turnSeq = design.turnSeq + 1;
  await ctx.scheduler.runAfter(0, internal.agent.runTurn, { designId: design._id, turnSeq });
  await ctx.db.patch(design._id, {
    status: "thinking",
    turnSeq,
    turnDeadline: now + TURN_LEASE_MS,
    lastError: null,
  });
  design.turnSeq = turnSeq;
  design.status = "thinking";
  return turnSeq;
}

/**
 * A proposal is waiting for a browser: open the claim window. Nobody owns it
 * yet; the first claimRender wins. The backstop fires if nobody claims.
 */
export async function openRenderWindow(
  ctx: MutationCtx,
  design: Design,
  now: number,
  attemptNo: number,
  presetId: string,
): Promise<void> {
  await ctx.db.patch(design._id, {
    renderOwnerClientId: null,
    renderLeaseUntil: now + RENDER_LEASE_MS,
    renderAttemptNo: attemptNo,
  });
  await ctx.scheduler.runAfter(RENDER_LEASE_MS + 1_000, internal.render.leaseExpired, {
    designId: design._id,
    presetId,
    attemptNo,
  });
}

/** Grant the lease to a claimant and arm the backstop for this generation. */
export async function grantRender(
  ctx: MutationCtx,
  design: Design,
  clientId: string,
  now: number,
  attemptNo: number,
  presetId: string,
): Promise<void> {
  await ctx.db.patch(design._id, {
    renderOwnerClientId: clientId,
    renderLeaseUntil: now + RENDER_LEASE_MS,
    renderAttemptNo: attemptNo,
  });
  await ctx.scheduler.runAfter(RENDER_LEASE_MS + 1_000, internal.render.leaseExpired, {
    designId: design._id,
    presetId,
    attemptNo,
  });
}

/**
 * Give up on a render and answer its tool_use, so the conversation stays
 * usable. The design fails; slice 4's endDesign also frees the musician.
 */
export async function abandonRender(ctx: MutationCtx, design: Design, why: string): Promise<void> {
  if (design.pendingToolUseId) {
    await appendMessage(ctx, design._id, {
      role: "user",
      content: [abandonedRenderToolResult(design.pendingToolUseId, why)],
    });
  }
  await ctx.db.patch(design._id, {
    status: "failed",
    pendingToolUseId: null,
    pendingPresetId: null,
    renderOwnerClientId: null,
    renderLeaseUntil: 0,
    lastError: `That render was never completed (${why}).`,
  });
  await designNote(ctx, design, `The sound design stopped: a render was never completed (${why}).`);
}

/** A claim window or lease lapsed: reopen it for the next caller, or give up. */
export async function reopenOrAbandonRender(ctx: MutationCtx, design: Design, now: number): Promise<void> {
  const next = design.renderAttemptNo + 1;
  if (next > MAX_RENDER_ATTEMPTS) {
    await abandonRender(ctx, design, "no browser could complete it");
    return;
  }
  await openRenderWindow(ctx, design, now, next, design.pendingPresetId!);
}
