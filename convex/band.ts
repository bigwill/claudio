/**
 * Band turns (plan §4): a musician answering the chat.
 *
 *   drainInbox (model/inbox.ts) → runBandTurn (action: one Sonnet 5 call via
 *   llm.ts) → commit (fenced mutation: one merged part version, one
 *   tool_result per tool_use, the says as threaded chat rows) → drain again.
 *
 * Every terminal branch is fenced on turnSeq and ends idle with a drain, so a
 * turn that fails, times out or is reclaimed never wedges the musician.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { fakeBandMessage } from "./fakeClaude";
import { callModel } from "./llm";
import { toolsFor } from "./model/bandTools";
import { postChat } from "./model/chat";
import { planCommit } from "./model/commit";
import { pipLabels } from "./model/history";
import { answeredNote, drainInbox } from "./model/inbox";
import { appendPart, historyRows, newestPart, newTxn } from "./model/jam";
import { LLM } from "./model/llmConfig";
import { appendMessage, decodeContent, loadMessages, mergeAdjacentRoles, type MessageParam } from "./model/messages";
import { bandSystem } from "./prompts/band";
import type { BandRole, Pattern } from "../src/shared/pattern";

const IGNORE_NOTE = "[the previous request failed; ignore it]";

/** Everything the action needs, in one read. Null when the turn was superseded. */
export const planBandTurn = internalQuery({
  args: { musicianId: v.id("musicians"), turnSeq: v.number() },
  returns: v.union(v.null(), v.object({ role: v.union(v.literal("drums"), v.literal("bass"), v.literal("keys")), messagesJson: v.string() })),
  handler: async (ctx, { musicianId, turnSeq }) => {
    const m = await ctx.db.get(musicianId);
    if (!m || m.turnSeq !== turnSeq || m.status !== "thinking" || m.role === "producer") return null;
    // JSON text: a query's return value is key-sorted on its way to the action.
    return { role: m.role, messagesJson: JSON.stringify(await loadMessages(ctx, musicianId)) };
  },
});

export const runBandTurn = internalAction({
  args: { musicianId: v.id("musicians"), turnSeq: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await ctx.runQuery(internal.band.planBandTurn, args);
    if (!plan) return null;
    const messages = JSON.parse(plan.messagesJson) as MessageParam[];
    const role = plan.role as BandRole;
    const outcome = await callModel(
      ctx,
      "band",
      {
        model: LLM.band.model,
        max_tokens: LLM.band.maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: LLM.band.effort },
        system: bandSystem(role),
        tools: toolsFor(role),
        // Forced tool use, parallel calls allowed: a pattern and a sound may land together.
        tool_choice: { type: "any" },
        messages: mergeAdjacentRoles(messages),
      },
      {
        match: role,
        turnIndex: messages.filter((m) => m.role === "assistant").length,
        fallback: () => fakeBandMessage(role, messages),
      },
    );
    if (outcome.kind === "hang") return null; // the watchdog reclaims it
    if (outcome.kind !== "message") {
      await failOrLog(ctx, { ...args, reason: outcome.kind, detail: outcome.kind === "error" ? outcome.message : "" });
      return null;
    }
    const committed = await withRetry(() =>
      ctx.runMutation(internal.band.commit, { ...args, content: JSON.stringify(outcome.content), stopReason: outcome.stopReason }),
    );
    // Plan §4: if commit never lands, fail the turn (fenced) with the ignore note.
    if (!committed) await failOrLog(ctx, { ...args, reason: "error", detail: "the reply couldn't be saved" });
    return null;
  },
});

async function failOrLog(ctx: ActionCtx, args: { musicianId: Id<"musicians">; turnSeq: number; reason: string; detail: string }) {
  if (!(await withRetry(() => ctx.runMutation(internal.band.fail, args)))) console.error("band.fail did not land", args);
}

async function withRetry(fn: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (attempt === 2) console.error("band mutation failed after 3 attempts", err);
    }
  }
  return false;
}

/**
 * Land a band turn (plan §4 commit, in order). Never catches its own errors,
 * so a thrown commit rolls back cleanly and the action's fallback fails the turn.
 */
export const commit = internalMutation({
  args: { musicianId: v.id("musicians"), turnSeq: v.number(), content: v.string(), stopReason: v.union(v.null(), v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.musicianId);
    if (!m || m.turnSeq !== args.turnSeq || m.status !== "thinking" || m.role === "producer") return null; // FENCE

    // 1. A refusal or a cut-off turn saves nothing.
    if (args.stopReason === "refusal" || args.stopReason === "max_tokens") {
      await failTurn(ctx, m, args.stopReason);
      return null;
    }
    // 2. The assistant turn, exactly as returned.
    const content = decodeContent(args.content) as Array<{ type: string; id?: string; name?: string; input?: unknown }>;
    await appendMessage(ctx, m._id, { role: "assistant", content });

    // 3–4. Validate every call; merge the valid ones into one version.
    const current = await newestPart(ctx, m._id);
    const sound = current.libraryId ? await ctx.db.get(current.libraryId) : null;
    const library = m.role === "drums" ? [] : await libraryFor(ctx, m.role, m.jamId);
    const calls = content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id!, name: b.name!, input: b.input }));
    const plan = planCommit({
      role: m.role,
      calls,
      current: { lengthBars: current.lengthBars, notes: current.notes as Pattern["notes"], soundName: sound?.name ?? null, preset: sound?.preset ?? null },
      library: library.map((l) => ({ id: l._id, name: l.name })),
    });
    let libraryId = current.libraryId;
    if (plan.sound?.kind === "tweak" && m.role !== "drums") {
      libraryId = await ctx.db.insert("library", {
        name: plan.sound.preset.name,
        role: m.role,
        preset: plan.sound.preset,
        features: null,
        origin: "tweak",
        source: `tweak of ${sound?.name ?? "the starter sound"}`,
        designId: null,
        fromJamId: m.jamId,
        starterKey: null,
      });
    } else if (plan.sound?.kind === "library") {
      libraryId = plan.sound.libraryId as Id<"library">;
    }
    if (plan.part || plan.sound) {
      await appendPart(ctx, current, {
        source: "agent",
        label: plan.says.join(" / ") || "New part",
        lengthBars: plan.part?.lengthBars ?? current.lengthBars,
        notes: (plan.part?.notes ?? current.notes) as Doc<"parts">["notes"],
        libraryId,
        txn: newTxn(),
      });
    }
    // 5. One tool_result per tool_use, in order.
    if (plan.results.length) await appendMessage(ctx, m._id, { role: "user", content: plan.results as Anthropic.ToolResultBlockParam[] });

    // 8 (idle first, so the rows below drain the others against a settled turn).
    await ctx.db.patch(m._id, { status: "idle", turnSeq: m.turnSeq + 1, turnDeadline: 0, turnCause: null });
    // 6. Each say, threaded under the note it answers.
    const replyToSeq = await answeredNote(ctx, m);
    for (const say of plan.says) await postChat(ctx, m.jamId, { kind: "musician", text: say, fromMusicianId: m._id, replyToSeq });
    if (!plan.part && !plan.sound && plan.errors.length) {
      await postChat(ctx, m.jamId, {
        kind: "system",
        text: `${m.name}'s change didn't validate (${plan.errors[0]}). Still on ${await versionLabel(ctx, m._id)}.`,
        to: [m._id],
      });
    }
    await drainInbox(ctx, m._id);
    return null;
  },
});

/** The action's failure path: timeout, error, or a commit that never landed. Fenced. */
export const fail = internalMutation({
  args: { musicianId: v.id("musicians"), turnSeq: v.number(), reason: v.string(), detail: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const m = await ctx.db.get(args.musicianId);
    if (!m || m.turnSeq !== args.turnSeq || m.status !== "thinking") return null; // FENCE
    await failTurn(ctx, m, args.reason, args.detail);
    return null;
  },
});

/**
 * End a turn that produced nothing (plan §4 fail): append the ignore note so
 * the failed request isn't re-executed, go idle (bumping the fence), post the
 * failure copy with context, and drain.
 */
export async function failTurn(ctx: MutationCtx, m: Doc<"musicians">, reason: string, detail = ""): Promise<void> {
  await appendMessage(ctx, m._id, { role: "user", content: IGNORE_NOTE });
  await ctx.db.patch(m._id, { status: "idle", turnSeq: m.turnSeq + 1, turnDeadline: 0, turnCause: null });
  const still = `Still on ${await versionLabel(ctx, m._id)}.`;
  const copy: Record<string, string> = {
    timeout: `${m.name} didn't answer in time. ${still}`,
    stuck: `${m.name} stopped responding. ${still}`,
    refusal: `${m.name} declined that one. ${still}`,
    max_tokens: `${m.name} ran out of room answering. ${still}`,
    error: `${m.name} couldn't answer (${detail}). ${still}`,
  };
  await postChat(ctx, m.jamId, { kind: "system", text: copy[reason] ?? copy.error, to: [m._id] });
  await drainInbox(ctx, m._id);
}

async function versionLabel(ctx: MutationCtx, musicianId: Id<"musicians">): Promise<string> {
  const rows = await historyRows(ctx, musicianId);
  const current = rows[rows.length - 1];
  return pipLabels(rows).find((p) => p.basedOn === current.basedOn)?.label ?? `v${current.basedOn}`;
}

/** A pitched musician's library: this jam's sounds and the starters. */
async function libraryFor(ctx: MutationCtx, role: "bass" | "keys", jamId: Id<"jams">): Promise<Doc<"library">[]> {
  const ours = await ctx.db
    .query("library")
    .withIndex("by_role_jam", (q) => q.eq("role", role).eq("fromJamId", jamId))
    .order("desc")
    .take(50);
  const starters = await ctx.db
    .query("library")
    .withIndex("by_role_jam", (q) => q.eq("role", role).eq("fromJamId", null))
    .take(50);
  return [...ours, ...starters];
}
