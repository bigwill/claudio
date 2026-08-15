import { DurableObject } from "cloudflare:workers";
import type Anthropic from "@anthropic-ai/sdk";

import { clampPreset, type ClaudioPreset } from "../shared/preset";
import type { FeatureDiff, FeatureSummary } from "../shared/features";
import {
  MAX_ITERATIONS,
  type Attempt,
  type SessionSnapshot,
  type SessionStatus,
  type Step,
  type TargetInfo,
} from "../shared/protocol";
import { MissingApiKeyError, runClaude, type MessageParam } from "./agent";

/**
 * One Durable Object per sound-design session.
 *
 * Holds the paused Anthropic conversation between HTTP round trips: the agent's
 * turn stops at a tool_use block, and can only be resumed once the browser has
 * rendered + analyzed the proposed preset. `pendingToolUseId` is what survives
 * that gap — on submitAnalysis we synthesize a tool_result carrying that exact
 * id, append it, and call the model again. See PLAN.md "The agent loop protocol".
 *
 * Two tables rather than one blob: the message log grows unboundedly across chat
 * turns and would eventually blow the 128 KiB per-value limit.
 */

interface Meta {
  status: SessionStatus;
  target: FeatureSummary | null;
  targetInfo: TargetInfo | null;
  iteration: number;
  maxIterations: number;
  history: Attempt[];
  bestPresetId: string | null;
  bestDistance: number | null;
  /** The crux: the tool_use we owe a tool_result for. */
  pendingToolUseId: string | null;
  pendingPresetId: string | null;
}

const freshMeta = (): Meta => ({
  status: "idle",
  target: null,
  targetInfo: null,
  iteration: 0,
  maxIterations: MAX_ITERATIONS,
  history: [],
  bestPresetId: null,
  bestDistance: null,
  pendingToolUseId: null,
  pendingPresetId: null,
});

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** Thrown for client mistakes (stale presetId, wrong status) — mapped to 409. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class SessionDO extends DurableObject<Env> {
  private meta: Meta = freshMeta();
  private messages: MessageParam[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (
           id INTEGER PRIMARY KEY CHECK(id = 1),
           json TEXT NOT NULL
         );`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS messages (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           json TEXT NOT NULL
         );`,
      );

      const metaRows = [
        ...this.ctx.storage.sql.exec<{ json: string }>(`SELECT json FROM meta WHERE id = 1`),
      ];
      if (metaRows.length > 0) {
        this.meta = { ...freshMeta(), ...(JSON.parse(metaRows[0].json) as Partial<Meta>) };
      }

      const msgRows = [
        ...this.ctx.storage.sql.exec<{ json: string }>(`SELECT json FROM messages ORDER BY seq ASC`),
      ];
      this.messages = msgRows.map((row) => JSON.parse(row.json) as MessageParam);
    });
  }

  /** Liveness probe used by /api/ping so we exercise the DO binding end to end. */
  async ping(): Promise<{ ok: true; id: string }> {
    return { ok: true, id: this.ctx.id.toString() };
  }

  // -------------------------------------------------------------------------
  // Persistence helpers. Never held across a network call.
  // -------------------------------------------------------------------------

  private saveMeta(): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (id, json) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      JSON.stringify(this.meta),
    );
  }

  private appendMessage(message: MessageParam): void {
    this.messages.push(message);
    this.ctx.storage.sql.exec(`INSERT INTO messages (json) VALUES (?)`, JSON.stringify(message));
  }

  // -------------------------------------------------------------------------
  // RPC surface
  // -------------------------------------------------------------------------

  async snapshot(): Promise<SessionSnapshot> {
    return {
      sessionId: this.ctx.id.toString(),
      status: this.meta.status,
      target: this.meta.target,
      targetInfo: this.meta.targetInfo,
      iteration: this.meta.iteration,
      maxIterations: this.meta.maxIterations,
      history: this.meta.history,
      bestPresetId: this.meta.bestPresetId,
    };
  }

  async setTarget(features: FeatureSummary, info: TargetInfo): Promise<Step> {
    this.meta = {
      ...freshMeta(),
      status: "thinking",
      target: features,
      targetInfo: info,
    };
    // A re-upload starts a new conversation; the old message log is dead weight
    // and its tool_use ids no longer mean anything.
    this.messages = [];
    this.ctx.storage.sql.exec(`DELETE FROM messages`);
    this.saveMeta();

    this.appendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text:
            `The user uploaded "${info.filename}" (${info.durationSec.toFixed(2)}s @ ${info.sampleRate} Hz).\n` +
            `Here is its feature vector:\n\n` +
            "```json\n" +
            JSON.stringify(features) +
            "\n```\n\n" +
            `You have ${this.meta.maxIterations} render iterations. Pick an archetype that explains these ` +
            `features and instantiate it, then call propose_preset. The browser will render it and return a diff.`,
        },
      ],
    });

    return await this.turn({ force: true, isFirstProposal: true });
  }

  async submitAnalysis(presetId: string, features: FeatureSummary, diff: FeatureDiff): Promise<Step> {
    const toolUseId = this.requirePending(presetId);

    // Record the measurement against the attempt it belongs to.
    const attempt = this.meta.history.find((a) => a.presetId === presetId);
    if (attempt) {
      attempt.features = features;
      attempt.distance = diff.distance;
    }
    if (this.meta.bestDistance === null || diff.distance < this.meta.bestDistance) {
      this.meta.bestDistance = diff.distance;
      this.meta.bestPresetId = presetId;
    }

    this.meta.pendingToolUseId = null;
    this.meta.pendingPresetId = null;
    this.meta.status = "thinking";
    this.saveMeta();

    const remaining = this.iterationsRemaining();
    this.appendMessage({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: JSON.stringify({
            distance: diff.distance,
            breakdown: diff.breakdown,
            verdict: diff.verdict,
            priorities: diff.priorities,
            scalars: diff.scalars,
            harmonics: diff.harmonics,
            iteration: this.meta.iteration,
            iterations_remaining: remaining,
            best_distance_so_far: this.meta.bestDistance,
            note:
              remaining <= 0
                ? "Iteration budget exhausted. You MUST call finalize now, with the BEST preset seen (lowest distance so far), not necessarily this one."
                : `Either propose the next preset with propose_preset (attack the largest weighted errors in priorities[], one or two changes, and say what you expect), or call finalize if this is good enough. You MUST call finalize when iterations_remaining reaches 0.`,
          }),
        },
      ],
    });

    return await this.turn({ force: true, isFirstProposal: false });
  }

  async submitRenderError(presetId: string, message: string): Promise<Step> {
    const toolUseId = this.requirePending(presetId);

    this.meta.pendingToolUseId = null;
    this.meta.pendingPresetId = null;
    this.meta.status = "thinking";
    this.saveMeta();

    this.appendMessage({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: true,
          content: JSON.stringify({
            error: message.slice(0, 500),
            iterations_remaining: this.iterationsRemaining(),
            note: "That preset failed to render — a value was probably out of range or otherwise invalid. Fix it and propose a corrected preset. This did not consume the render, but do not repeat the same mistake.",
          }),
        },
      ],
    });

    return await this.turn({ force: true, isFirstProposal: false });
  }

  async chat(message: string): Promise<Step> {
    if (this.meta.status === "thinking") {
      throw new ProtocolError("A turn is already in flight for this session.");
    }
    if (this.meta.status === "awaiting_render") {
      throw new ProtocolError("Still waiting on a render; submit the analysis (or a render error) first.");
    }

    this.meta.status = "thinking";
    this.saveMeta();

    this.appendMessage({ role: "user", content: [{ type: "text", text: message }] });

    // Chat gets tool_choice "auto": "what does modEnv do?" deserves a text
    // answer, not a forced preset.
    return await this.turn({ force: false, isFirstProposal: false });
  }

  // -------------------------------------------------------------------------
  // The driver
  // -------------------------------------------------------------------------

  private requirePending(presetId: string): string {
    // The entire idempotency story: a double-click, a retry, or a mid-render
    // reload cannot desync the conversation.
    if (this.meta.status !== "awaiting_render" || !this.meta.pendingToolUseId) {
      throw new ProtocolError(
        `Session is "${this.meta.status}", not awaiting a render — nothing to submit.`,
      );
    }
    if (presetId !== this.meta.pendingPresetId) {
      throw new ProtocolError(
        `Stale preset: expected "${this.meta.pendingPresetId}", got "${presetId}". Ignoring.`,
      );
    }
    return this.meta.pendingToolUseId;
  }

  private iterationsRemaining(): number {
    return Math.max(0, this.meta.maxIterations - this.meta.iteration);
  }

  private lastPreset(): ClaudioPreset | null {
    return this.meta.history.length > 0
      ? this.meta.history[this.meta.history.length - 1].preset
      : null;
  }

  private async turn(opts: { force: boolean; isFirstProposal: boolean }): Promise<Step> {
    let message: Anthropic.Message;
    try {
      message = await runClaude({
        apiKey: this.env.ANTHROPIC_API_KEY,
        messages: this.messages,
        force: opts.force,
        isFirstProposal: opts.isFirstProposal,
      });
    } catch (err) {
      // Never leave status on "thinking" — that wedges the session permanently.
      this.meta.status = this.meta.pendingToolUseId ? "awaiting_render" : "idle";
      this.saveMeta();
      const missing = err instanceof MissingApiKeyError;
      return {
        kind: "error",
        message: missing ? (err as Error).message : `Claude call failed: ${String(err)}`,
        retryable: true,
      };
    }

    // Persist the assistant turn verbatim — thinking blocks and tool_use blocks
    // included. Editing or dropping them breaks the next turn.
    this.appendMessage({ role: "assistant", content: message.content });

    let text = "";
    let call: ToolCall | null = null;
    for (const block of message.content) {
      if (block.type === "text") text += (text ? "\n\n" : "") + block.text;
      else if (block.type === "tool_use" && !call) {
        call = { id: block.id, name: block.name, input: block.input };
      }
    }

    if (call && call.name === "propose_preset") {
      const { preset, rationale } = readToolInput(call.input);
      const presetId = crypto.randomUUID();

      this.meta.iteration += 1;
      this.meta.pendingToolUseId = call.id;
      this.meta.pendingPresetId = presetId;
      this.meta.status = "awaiting_render";
      this.meta.history.push({ presetId, preset, rationale, features: null, distance: null });
      this.saveMeta();

      return {
        kind: "render",
        presetId,
        preset,
        rationale,
        iteration: this.meta.iteration,
        iterationsRemaining: this.iterationsRemaining(),
        note: text,
      };
    }

    if (call && call.name === "finalize") {
      const { preset, rationale } = readToolInput(call.input);
      const presetId = crypto.randomUUID();

      this.meta.pendingToolUseId = null;
      this.meta.pendingPresetId = null;
      this.meta.status = "done";
      this.meta.history.push({ presetId, preset, rationale, features: null, distance: null });
      this.saveMeta();

      return {
        kind: "done",
        text: text ? `${text}\n\n${rationale}` : rationale,
        preset,
        presetId,
        distance: this.meta.bestDistance,
      };
    }

    // Plain text answer (only reachable from chat, where tool_choice is "auto").
    this.meta.status = "idle";
    this.saveMeta();
    return {
      kind: "message",
      text: text || "(no response)",
      preset: this.lastPreset(),
      iteration: this.meta.iteration,
    };
  }
}

/** Tool input is agent-authored JSON — clamp it before it can reach an AudioParam. */
function readToolInput(input: unknown): { preset: ClaudioPreset; rationale: string } {
  const obj = (input ?? {}) as { preset?: unknown; rationale?: unknown };
  return {
    preset: clampPreset(obj.preset),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}
