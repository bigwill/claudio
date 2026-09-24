/**
 * The Anthropic conversation log, and the exact strings fed back into it.
 *
 * The tool_result bodies below are ported VERBATIM from SessionDO. They are
 * prompt engineering, not plumbing — the wording of `note` is what makes the
 * agent finalize on time and attack the right error — so resist tidying them.
 *
 * Plain helpers taking `ctx`, per Convex's guidance: business logic lives in
 * model/, and the registered functions in convex/*.ts stay thin.
 */

import type Anthropic from "@anthropic-ai/sdk";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { FeatureDiff, FeatureSummary } from "../../src/shared/features";

/**
 * Narrower than Anthropic.MessageParam on purpose: only user and assistant turns
 * are ever persisted (the system prompt is sent separately, per request), and the
 * `role` column is typed to match.
 */
export interface MessageParam {
  role: "user" | "assistant";
  content: unknown;
}

/**
 * The log stores each message's content as its JSON TEXT, not as a Convex
 * object. Convex sorts object fields by key, so a stored tool_use input came
 * back alphabetized while the strict schema made the model write it in schema
 * order; replaying the reordered calls made later design turns stub the leading
 * fields ("x", 0, "placeholder"). JSON text keeps the log exactly as returned.
 * Rows written before this change hold objects and still decode.
 */
export function encodeContent(content: unknown): string {
  return JSON.stringify(content);
}

export function decodeContent(stored: unknown): unknown {
  return typeof stored === "string" ? JSON.parse(stored) : stored;
}

/**
 * Merge adjacent same-role messages, the same way on every call. The Anthropic
 * docs disagree on whether consecutive user messages are allowed; merging makes
 * it moot. Nothing stored is edited: this shapes the request only.
 */
export function mergeAdjacentRoles(messages: MessageParam[]): MessageParam[] {
  const blocks = (c: unknown): unknown[] => (typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [c]);
  const out: MessageParam[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = [...blocks(last.content), ...blocks(m.content)];
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** What the diff needs to look like to be serialized into a tool_result. */
type DiffForPrompt = Pick<
  FeatureDiff,
  "distance" | "breakdown" | "verdict" | "priorities"
> & {
  scalars: readonly unknown[];
  harmonics: readonly unknown[];
};

/** A design log is ~10 messages; band logs are windowed in slice 5 before they get near this. */
const MAX_LOG_MESSAGES = 400;

export type ConvoId = Id<"musicians"> | Id<"designs">;

/** The newest message of a conversation, or null. */
export async function tailMessage(ctx: QueryCtx, convoId: ConvoId): Promise<Doc<"messages"> | null> {
  return await ctx.db
    .query("messages")
    .withIndex("by_convo_seq", (q) => q.eq("convoId", convoId))
    .order("desc")
    .first();
}

/**
 * Append to a conversation. The next seq is read newest-first from the index,
 * plus one: no counter on the (subscribed) musician or design document, so an
 * append never re-runs a query that reads them.
 */
export async function appendMessage(ctx: MutationCtx, convoId: ConvoId, message: MessageParam): Promise<number> {
  const tail = await tailMessage(ctx, convoId);
  const seq = tail ? tail.seq + 1 : 0;
  await ctx.db.insert("messages", {
    convoId,
    seq,
    role: message.role,
    content: encodeContent(message.content),
  });
  return seq;
}

export async function loadMessages(ctx: QueryCtx, convoId: ConvoId): Promise<MessageParam[]> {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_convo_seq", (q) => q.eq("convoId", convoId))
    .order("asc")
    .take(MAX_LOG_MESSAGES);
  if (rows.length === MAX_LOG_MESSAGES) throw new Error(`conversation ${convoId} hit ${MAX_LOG_MESSAGES} messages`);
  return rows.map((r) => ({ role: r.role, content: decodeContent(r.content) }) as MessageParam);
}

/**
 * Answer any tool_use left dangling at the tail of the log.
 *
 * The Durable Object had this as `healDanglingToolUse()` and it was UNREACHABLE:
 * every caller of `turn()` appended a user message first, so the tail was never
 * an assistant turn and the guard returned immediately every time. Here it is
 * called from the paths that are about to append a user turn, BEFORE they do —
 * which is the only position where it can actually fire.
 *
 * Returns blocks to prepend to the user turn being built. Callers that are
 * already answering the pending tool_use properly (submitAnalysis,
 * submitRenderError) must NOT use this — they have a real result to give.
 */
export function healBlocks(tail: Doc<"messages"> | null): Anthropic.ToolResultBlockParam[] {
  const content = tail ? decodeContent(tail.content) : null;
  if (!tail || tail.role !== "assistant" || !Array.isArray(content)) return [];
  return (content as unknown[])
    .filter(
      (b): b is Anthropic.ToolUseBlockParam =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use",
    )
    .map((b) => ({
      type: "tool_result" as const,
      tool_use_id: b.id,
      content: "Acknowledged.",
    }));
}

// ---------------------------------------------------------------------------
// The tool_result bodies. Ported verbatim — see the note at the top.
// ---------------------------------------------------------------------------

export function analysisToolResult(args: {
  toolUseId: string;
  features: FeatureSummary;
  // DiffForPrompt, not FeatureDiff: the stored diff comes back through a
  // deliberately loose validator (`name` and `direction` are plain strings there,
  // not the literal unions), and this function only serializes it into a prompt.
  // Tightening the parameter would force a lie of a cast at every call site.
  diff: DiffForPrompt | null;
  iteration: number;
  iterationsRemaining: number;
  bestDistance: number | null;
}): Anthropic.ToolResultBlockParam {
  const { diff, iterationsRemaining: remaining } = args;
  return {
    type: "tool_result",
    tool_use_id: args.toolUseId,
    content: JSON.stringify(
      diff
        ? {
            distance: diff.distance,
            breakdown: diff.breakdown,
            verdict: diff.verdict,
            priorities: diff.priorities,
            scalars: diff.scalars,
            harmonics: diff.harmonics,
            iteration: args.iteration,
            iterations_remaining: remaining,
            best_distance_so_far: args.bestDistance,
            note:
              remaining <= 0
                ? "Iteration budget exhausted. You MUST call finalize now, with the BEST preset seen (lowest distance so far), not necessarily this one."
                : `Either propose the next preset with propose_preset (attack the largest weighted errors in priorities[], one or two changes, and say what you expect), or call finalize if this is good enough. You MUST call finalize when iterations_remaining reaches 0.`,
          }
        : {
            rendered: true,
            measured_features: args.features,
            iteration: args.iteration,
            iterations_remaining: remaining,
            note:
              remaining <= 0
                ? "No target sample — there is nothing to score against. Iteration budget exhausted; call finalize now."
                : "No target sample: these are the features YOUR patch actually measures. Check them against what the user asked for — is it as bright, as percussive, as inharmonic as they described? Adjust with propose_preset if not, otherwise call finalize. One proposal is often enough here.",
          },
    ),
  };
}

export function renderErrorToolResult(args: {
  toolUseId: string;
  message: string;
  iterationsRemaining: number;
}): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: args.toolUseId,
    is_error: true,
    content: JSON.stringify({
      error: args.message.slice(0, 500),
      iterations_remaining: args.iterationsRemaining,
      note: "That preset failed to render — a value was probably out of range or otherwise invalid. Fix it and propose a corrected preset. This did not consume the render, but do not repeat the same mistake.",
    }),
  };
}

/**
 * MUST be appended in the same turn as the finalize tool_use. Unlike
 * propose_preset — whose tool_result arrives later from a browser — finalize is
 * resolved here and now, so leaving it dangling means the NEXT request is
 * rejected outright with
 *   400 `tool_use` ids were found without `tool_result` blocks
 * i.e. every conversation after a finalize would fail.
 */
export function finalizeToolResult(toolUseId: string): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content:
      "Finalized and loaded into the synth. The user can now play it and ask for changes. " +
      "From here the target sample no longer matters — follow what they ask for.",
  };
}

export function unknownToolResult(
  toolUseId: string,
  name: string,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: `Unknown tool "${name}". Use propose_preset or finalize.`,
    is_error: true,
  };
}

/**
 * Close a render nobody is going to complete.
 *
 * The single-player version of this fired when a user chatted after reloading
 * mid-render. The multiplayer version also fires when every contributor has left,
 * or when the render has been re-granted MAX_RENDER_ATTEMPTS times — the point is
 * the same: answer the tool call rather than demanding a measurement that will
 * never arrive, because an unanswered tool_use bricks the conversation.
 */
export function abandonedRenderToolResult(
  toolUseId: string,
  why: string,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    is_error: true,
    content: `That render was never completed (${why}). No measurement is available for it.`,
  };
}
