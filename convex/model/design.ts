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
 * Every terminal branch goes through endDesign (plan §4): finalize, fail, the
 * stop reasons, the second no-tool strike, an abandoned render, cancel and
 * the watchdog. It frees the musician and drains its held inbox.
 */

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";

import type { FeatureSummary } from "../../src/shared/features";
import { MAX_ITERATIONS, MAX_RENDER_ATTEMPTS, RENDER_LEASE_MS, TURN_LEASE_MS, type RenderSpec } from "../../src/shared/protocol";
import { postChat } from "./chat";
import { planDrain, type DrainPlan } from "./drain";
import { appendPart, discardTurn, newestPart, newTxn } from "./jam";
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
 * usable, then end the design.
 */
export async function abandonRender(ctx: MutationCtx, design: Design, why: string): Promise<void> {
  if (design.pendingToolUseId) {
    await appendMessage(ctx, design._id, {
      role: "user",
      content: [abandonedRenderToolResult(design.pendingToolUseId, why)],
    });
  }
  await endDesign(ctx, design, { kind: "failed", why: `a render was never completed (${why})` });
}

export type DesignOutcome = { kind: "done"; attempt: Doc<"attempts"> } | { kind: "failed"; why: string };

/**
 * The one way a design ends (plan §4). Sets its status and fences its turn;
 * frees the musician (activeDesignId); on finalize inserts a `designed`
 * library row and appends a `design` part version (same notes, new sound);
 * posts a system row to the musician; then drains its held inbox.
 */
export async function endDesign(ctx: MutationCtx, design: Design, outcome: DesignOutcome): Promise<void> {
  const fresh = (await ctx.db.get(design._id)) ?? design;
  if (fresh.status === "done" || fresh.status === "failed") return;
  await ctx.db.patch(design._id, {
    status: outcome.kind,
    turnSeq: fresh.turnSeq + 1,
    turnDeadline: 0,
    pendingToolUseId: null,
    pendingPresetId: null,
    renderOwnerClientId: null,
    renderLeaseUntil: 0,
    lastError: outcome.kind === "failed" ? outcome.why : null,
  });
  const m = await ctx.db.get(design.musicianId);
  if (!m) return;
  if (m.activeDesignId === design._id) await ctx.db.patch(m._id, { activeDesignId: null });

  if (outcome.kind === "done") {
    const preset = outcome.attempt.preset;
    const libraryId = await ctx.db.insert("library", {
      name: preset.name,
      // The producer can play any pitched sound; their designs file under keys.
      role: m.role === "bass" ? "bass" : "keys",
      preset,
      features: null,
      origin: "designed",
      source: design.targetInfo?.filename ?? design.prompt ?? "a description",
      designId: design._id,
      fromJamId: m.jamId,
      starterKey: null,
    });
    const current = await newestPart(ctx, m._id);
    await appendPart(ctx, current, {
      source: "design",
      label: preset.name,
      lengthBars: current.lengthBars,
      notes: current.notes,
      libraryId,
      txn: newTxn(),
    });
    await postChat(ctx, m.jamId, { kind: "system", text: `${m.name} now plays ${preset.name}.`, to: [m._id] });
  } else {
    await postChat(ctx, m.jamId, { kind: "system", text: `${m.name}'s sound design stopped: ${outcome.why}.`, to: [m._id] });
  }
  await drainInbox(ctx, m._id);
}

/** planDrain over a musician's unread chat (plan §4 drainInbox, step 2). */
export async function inboxPlan(ctx: QueryCtx, musicianId: Id<"musicians">): Promise<DrainPlan> {
  const m = await ctx.db.get(musicianId);
  if (!m) return { action: "none" };
  const counters = await ctx.db
    .query("jamCounters")
    .withIndex("by_jam", (q) => q.eq("jamId", m.jamId))
    .unique();
  const jam = await ctx.db.get(m.jamId);
  const rows = await ctx.db
    .query("chat")
    .withIndex("by_jam_seq", (q) => q.eq("jamId", m.jamId).gt("seq", m.chatCursor))
    .take(50);
  return planDrain({
    musician: { id: m._id, kind: m.kind, status: m.status, activeDesignId: m.activeDesignId, chatCursor: m.chatCursor },
    rows: rows.map((r) => ({ seq: r.seq, kind: r.kind, fromMusicianId: r.fromMusicianId, to: r.to, reactor: r.reactor })),
    lastProducerSeq: counters?.lastProducerSeq ?? 0,
    reactionBudget: counters?.reactionBudget ?? 0,
    reactive: jam?.reactive ?? true,
  });
}

/**
 * Drain a musician's inbox. Slice 4 applies the cursor for "advance"; a
 * "turn" (a held producer note, say) stays unread until slice 5, where this
 * appends the user turn and begins the band turn in the same mutation.
 */
export async function drainInbox(ctx: MutationCtx, musicianId: Id<"musicians">): Promise<DrainPlan> {
  const plan = await inboxPlan(ctx, musicianId);
  if (plan.action === "advance") await ctx.db.patch(musicianId, { chatCursor: plan.cursor });
  return plan;
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

export type DesignSource =
  | { kind: "wav"; features: FeatureSummary; info: { filename: string; durationSec: number; sampleRate: number }; audioId: Id<"_storage"> | null }
  | { kind: "prompt"; text: string };

/**
 * Start a design: the one way in, whether from designs.start (a WAV or the
 * describe path) or from a "@keys design …" chat note (plan §4). Logs a
 * system row to the musician, frees it from any band turn in flight, and
 * schedules the first Claude turn, all in the caller's transaction.
 */
export async function startDesign(
  ctx: MutationCtx,
  musicianId: Id<"musicians">,
  source: DesignSource,
  spec: RenderSpec,
): Promise<Id<"designs">> {
  const m = await ctx.db.get(musicianId);
  if (!m) throw new ConvexError("no such musician");
  if (m.role === "drums") throw new ConvexError("Drums play the kit; there's no sound to design.");
  if (m.activeDesignId !== null) throw new ConvexError(`${m.name} is already designing a sound.`);
  const prompt = source.kind === "prompt" ? source.text.trim().slice(0, 2000) : null;
  if (source.kind === "prompt" && !prompt) throw new ConvexError("Describe the sound first.");
  await discardTurn(ctx, m); // your request wins over a band turn in flight

  const designId = await ctx.db.insert("designs", {
    musicianId,
    status: "thinking",
    origin: source.kind,
    target: source.kind === "wav" ? source.features : null,
    targetInfo: source.kind === "wav" ? source.info : null,
    targetAudioId: source.kind === "wav" ? source.audioId : null,
    prompt,
    renderSpec: spec,
    iteration: 0,
    pendingToolUseId: null,
    pendingPresetId: null,
    renderOwnerClientId: null,
    renderLeaseUntil: 0,
    renderAttemptNo: 0,
    turnSeq: 0,
    turnDeadline: 0,
    noToolStrikes: 0,
    lastError: null,
  });
  await ctx.db.patch(musicianId, { activeDesignId: designId });
  await postChat(ctx, m.jamId, {
    kind: "system",
    text: source.kind === "wav" ? `Designing ${m.name} from ${source.info.filename}` : `Designing ${m.name}: ${prompt}`,
    to: [m._id],
  });

  // The opening message is the original loop's, verbatim.
  const text =
    source.kind === "wav"
      ? `The user uploaded "${source.info.filename}" (${source.info.durationSec.toFixed(2)}s @ ${source.info.sampleRate} Hz).\n` +
        `Here is its feature vector:\n\n` +
        "```json\n" +
        JSON.stringify(source.features) +
        "\n```\n\n" +
        `You have ${MAX_ITERATIONS} render iterations. Pick an archetype that explains these ` +
        `features and instantiate it, then call propose_preset. The browser will render it and return a diff.`
      : `There is NO target sample this time. The user asked for a sound in their own words:\n\n` +
        `"${prompt}"\n\n` +
        `Design it from the description. Call propose_preset — the browser will render it and report ` +
        `back the features your patch actually measures, so you can check it against what you intended. ` +
        `There is no distance to minimise here; the user's words are the whole specification. ` +
        `Finalize as soon as the patch matches the description — one proposal is often enough.`;
  await appendMessage(ctx, designId, { role: "user", content: [{ type: "text", text }] });
  await beginDesignTurn(ctx, (await ctx.db.get(designId))!, Date.now());
  return designId;
}
