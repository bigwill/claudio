/**
 * The one place that talks to Anthropic.
 *
 * Runs in Convex's DEFAULT runtime, calling the Messages API with `fetch`
 * directly rather than through @anthropic-ai/sdk. Two attempts at using the SDK
 * failed for environmental reasons, and both are worth recording so nobody
 * re-litigates this:
 *
 *   1. In the default runtime it will not bundle — the SDK reaches for `node:fs`
 *      and `node:path` in its credential-loading paths.
 *   2. The `"use node"` escape hatch then refuses to deploy unless the machine
 *      has Node 20/22/24, which pins local development to a Node version for no
 *      benefit to this app.
 *
 * `fetch` costs us nothing here: every field of the request was already spelled
 * out explicitly in this codebase (that is deliberate — the shape is load-bearing
 * and commented as such), so the SDK was only ever supplying transport. Its
 * TYPES are still used, via type-only imports that erase at build time.
 *
 * Request-shape rules that will 400 if broken (do not "clean these up"):
 *   - no temperature / top_p / top_k on claude-opus-5
 *   - no assistant-turn prefill
 *   - thinking is ON BY DEFAULT and counts against max_tokens
 *   - disable_parallel_tool_use, because we can only ever render one preset
 */

import type Anthropic from "@anthropic-ai/sdk";

import { fakeClaudeMessage, fakeLlmEnabled } from "./fakeClaude";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { MAX_TOKENS, MODEL, MUST_CALL_TOOL_RULE, SYSTEM_BLOCKS, TOOLS } from "./prompt";
import { TURN_LEASE_MS } from "../src/shared/protocol";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * Bound the call explicitly.
 *
 * Under Cloudflare this was free: the edge killed any request past ~100s, so a
 * hung call could not outlive its turn. Nothing bounds it in a Convex action, so
 * without this a single wedged request could hold a session far past the point
 * anyone is still waiting. Kept under TURN_LEASE_MS so the abort fires before the
 * watchdog reclaims the turn underneath it.
 */
const REQUEST_TIMEOUT_MS = Math.floor(TURN_LEASE_MS * 0.6);

/**
 * The design model, switchable per deployment (plan slice 1b):
 *   npx convex env set DESIGN_MODEL claude-opus-5-5
 * Opus 5.5 rejects forced tool_choice ("any") with a 400, so on that model a
 * forced turn runs with "auto" plus a system rule that it must call a tool.
 * claude-opus-5 keeps the old "any" branch.
 */
function designModel(): string {
  return process.env.DESIGN_MODEL || MODEL;
}
const FORCED_TOOL_CHOICE_UNSUPPORTED = new Set(["claude-opus-5-5"]);

interface AnthropicResponse {
  content: unknown;
  stop_reason: string | null;
}

export const runTurn = internalAction({
  args: { designId: v.id("designs"), turnSeq: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const planned = await ctx.runQuery(internal.turn.planForAction, args);
    // Superseded: the session moved on while this action was starting. Not an
    // error — stop, and leave whoever owns the session now alone.
    if (!planned) return null;
    // Parsed here, not in the query: see planForAction's messagesJson.
    const plan = { ...planned, messages: JSON.parse(planned.messagesJson) as Anthropic.MessageParam[] };

    // Offline mode: skip the network entirely. Checked BEFORE the key lookup so
    // a machine with no ANTHROPIC_API_KEY still runs the full loop.
    if (fakeLlmEnabled()) {
      const fake = fakeClaudeMessage(plan as PlanForAction);
      await commitOrFail(ctx, args, () =>
        ctx.runMutation(internal.turn.commit, {
          designId: args.designId,
          turnSeq: args.turnSeq,
          content: JSON.stringify(fake.content),
          stopReason: fake.stop_reason,
        }),
      );
      return null;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      await fail(
        ctx,
        args,
        "ANTHROPIC_API_KEY is not set on this Convex deployment. Run: npx convex env set ANTHROPIC_API_KEY sk-ant-…",
        false,
      );
      return null;
    }

    let message: AnthropicResponse;
    try {
      message = await callClaude(apiKey, plan as PlanForAction);
    } catch (err) {
      await fail(ctx, args, `Claude call failed: ${String(err)}`, true);
      return null;
    }

    await commitOrFail(ctx, args, () =>
      ctx.runMutation(internal.turn.commit, {
        designId: args.designId,
        turnSeq: args.turnSeq,
        content: JSON.stringify(message.content),
        stopReason: message.stop_reason,
      }),
    );
    return null;
  },
});

interface PlanForAction {
  messages: Anthropic.MessageParam[];
  force: boolean;
  isFirstProposal: boolean;
}

async function callClaude(apiKey: string, plan: PlanForAction): Promise<AnthropicResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const model = designModel();
  const canForce = !FORCED_TOOL_CHOICE_UNSUPPORTED.has(model);
  const system =
    plan.force && !canForce ? [...SYSTEM_BLOCKS, { type: "text" as const, text: MUST_CALL_TOOL_RULE }] : SYSTEM_BLOCKS;

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        output_config: { effort: plan.isFirstProposal ? "medium" : "low" },
        system,
        tools: TOOLS,
        tool_choice:
          plan.force && canForce
            ? { type: "any", disable_parallel_tool_use: true }
            : { type: "auto", disable_parallel_tool_use: true },
        messages: plan.messages,
      }),
    });

    if (!res.ok) {
      // Include the body: Anthropic's 400s say exactly what is wrong with the
      // request shape, and that message is the difference between a five-minute
      // fix and an afternoon.
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} ${body.slice(0, 600)}`);
    }
    return (await res.json()) as AnthropicResponse;
  } finally {
    clearTimeout(timer);
  }
}

async function fail(
  ctx: ActionCtx,
  args: { designId: Id<"designs">; turnSeq: number },
  message: string,
  retryable: boolean,
): Promise<void> {
  await withRetry(() => ctx.runMutation(internal.turn.fail, { ...args, message, retryable }));
}

/**
 * Retry the commit, not the Claude call.
 *
 * The failure direction matters: if the model answered but the commit never
 * lands, tokens are burned and the log is UNCHANGED — no dangling tool_use,
 * nothing corrupted — and the watchdog frees the session. That is the good
 * outcome, and it is why this action writes nothing incrementally and commits
 * exactly once at the end. The turnSeq fence makes a duplicate commit a no-op,
 * so retrying costs nothing.
 */
async function withRetry(fn: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (attempt === 2) console.error("turn commit failed after 3 attempts", err);
    }
  }
  return false;
}

/**
 * The commit didn't land after its retries (plan §4: "If the action's
 * withRetry(commit) returns null, the action calls fail"). Fenced on turnSeq,
 * so this is a no-op if the commit actually did land.
 */
async function commitOrFail(ctx: ActionCtx, args: { designId: Id<"designs">; turnSeq: number }, commit: () => Promise<unknown>): Promise<void> {
  if (!(await withRetry(commit))) await fail(ctx, args, "the designer's reply couldn't be saved", true);
}
