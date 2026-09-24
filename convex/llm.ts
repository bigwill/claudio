/**
 * The single call site for every model call (plan §4, "A scripted fake LLM").
 *
 * One abort timer spans `fetch` and `res.json()`, set to the kind's timeout,
 * which sits below its lease (model/llmConfig.ts), so the action gives up
 * before the watchdog reclaims the turn underneath it.
 *
 * With CLAUDIO_FAKE_LLM=1 no network is touched: a fakeScripts row for
 * (match, turnIndex) wins, else the caller's deterministic fallback. A script
 * may be a raw message ({content, stop_reason}), `{delay}` (waited out on the
 * same abort signal, so a delay past the timeout exercises the real timeout
 * path) or `{hang: true}` (the action returns without committing, which
 * exercises the watchdog).
 *
 * Runs in Convex's default runtime with `fetch` (the SDK won't bundle there);
 * the SDK is used for types only.
 */
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { fakeLlmEnabled } from "./fakeClaude";
import { LLM, type LlmKind } from "./model/llmConfig";

export type ModelOutcome =
  | { kind: "message"; content: unknown; stopReason: string | null }
  | { kind: "timeout" }
  | { kind: "hang" }
  | { kind: "error"; message: string };

export interface FakeContext {
  match: string;
  turnIndex: number;
  fallback: () => { content: unknown; stop_reason: string | null };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

export async function callModel(ctx: ActionCtx, kind: LlmKind, body: Record<string, unknown>, fake: FakeContext): Promise<ModelOutcome> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), LLM[kind].timeoutMs);
  try {
    if (fakeLlmEnabled()) {
      const scripted = await ctx.runQuery(internal.testing.scriptFor, { match: fake.match, turnIndex: fake.turnIndex });
      const s = (scripted ? JSON.parse(scripted) : {}) as {
        hang?: boolean;
        delay?: number;
        /** Test-only: a shorter timeout, so a real-timer test can cross it quickly. Same abort path. */
        timeoutMs?: number;
        content?: unknown;
        stop_reason?: string | null;
      };
      if (s.hang) return { kind: "hang" };
      if (s.timeoutMs) {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), s.timeoutMs);
      }
      if (s.delay) await sleep(s.delay, controller.signal);
      if (s.content !== undefined) return { kind: "message", content: s.content, stopReason: s.stop_reason ?? null };
      const f = fake.fallback();
      return { kind: "message", content: f.content, stopReason: f.stop_reason };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { kind: "error", message: "ANTHROPIC_API_KEY is not set on this deployment" };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Anthropic's 400s say exactly what's wrong with the request; keep it.
      const text = await res.text().catch(() => "");
      return { kind: "error", message: `${res.status} ${text.slice(0, 400)}` };
    }
    const msg = (await res.json()) as { content: unknown; stop_reason: string | null };
    return { kind: "message", content: msg.content, stopReason: msg.stop_reason };
  } catch (e) {
    if (controller.signal.aborted) return { kind: "timeout" };
    return { kind: "error", message: String(e).slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}
