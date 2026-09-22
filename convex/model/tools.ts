/**
 * Reading agent-authored tool input.
 *
 * Ported from SessionDO.readToolInput. This is MANDATORY and it matters more
 * after the port, not less: `clampPreset` is what stops a hallucinated value
 * reaching an AudioParam (where a NaN permanently poisons the node), AND it is
 * what stops a hallucinated value reaching the database, where a validator would
 * reject the insert and throw the whole transaction — wedging the session on
 * every turn, forever, because the model would make the same call again.
 *
 * So: clamp before insert, never validate-and-reject.
 */

import { clampPreset, type ClaudioPreset } from "../../src/shared/preset";
import { SUGGESTION_COUNT } from "../../src/shared/protocol";

export interface ToolInput {
  preset: ClaudioPreset;
  rationale: string;
  suggestions: string[];
}

export function readToolInput(input: unknown): ToolInput {
  const obj = (input ?? {}) as {
    preset?: unknown;
    rationale?: unknown;
    suggestions?: unknown;
  };
  // Agent-authored, so treat as untrusted: strings only, trimmed, capped in
  // both count and length so a runaway response can't wreck the chip row.
  const suggestions = Array.isArray(obj.suggestions)
    ? obj.suggestions
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, SUGGESTION_COUNT)
        .map((s) => (s.length > 48 ? `${s.slice(0, 47)}…` : s))
    : [];
  return {
    preset: clampPreset(obj.preset),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    suggestions,
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Split an assistant turn into prose and its first tool call.
 *
 * First only: `disable_parallel_tool_use` is set on every request precisely
 * because we can render exactly one preset, so a second tool_use would be one we
 * could never answer.
 */
export function readAssistantTurn(content: unknown): { text: string; call: ToolCall | null } {
  let text = "";
  let call: ToolCall | null = null;
  if (!Array.isArray(content)) return { text, call };

  for (const raw of content) {
    const block = raw as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
    if (block?.type === "text" && typeof block.text === "string") {
      text += (text ? "\n\n" : "") + block.text;
    } else if (block?.type === "tool_use" && !call && typeof block.id === "string") {
      call = { id: block.id, name: String(block.name ?? ""), input: block.input };
    }
  }
  return { text, call };
}
