/**
 * Offline stand-in for the Anthropic API.
 *
 * Enabled by setting CLAUDIO_FAKE_LLM=1 on the deployment:
 *
 *   npx convex env set CLAUDIO_FAKE_LLM 1     # offline
 *   npx convex env remove CLAUDIO_FAKE_LLM    # back to real Claude
 *
 * This exists so the whole loop — turn scheduling, fencing tokens, render
 * leases, presence, multi-author chat — can be exercised on a plane. Those are
 * the parts being built; the model is the part that is already understood, and
 * it is the only piece that needs the network.
 *
 * It returns the SAME shape callClaude does (an Anthropic message: a content
 * block array plus stop_reason), so nothing downstream can tell the difference.
 * In particular it emits a real `tool_use` block with a fresh id, because that
 * id is the crux of the whole protocol: turn.commit persists it as
 * pendingToolUseId, and the render path owes it a matching tool_result.
 *
 * Deterministic, not random: the same conversation length always produces the
 * same patch, so a bug reproduces on the next run instead of moving around.
 */

import { DEFAULT_PRESET } from "../src/shared/preset";
import { SUGGESTION_COUNT } from "../src/shared/protocol";

interface FakePlan {
  messages: unknown[];
  force: boolean;
  isFirstProposal: boolean;
}

/** Is the offline stub active? */
export function fakeLlmEnabled(): boolean {
  return process.env.CLAUDIO_FAKE_LLM === "1";
}

/** Cheap deterministic id, shaped like Anthropic's toolu_… ids. */
function fakeToolUseId(seed: number): string {
  return `toolu_fake${String(seed).padStart(6, "0")}`;
}

/**
 * Walk the patch somewhere new on each turn, within the ranges clampPreset
 * enforces anyway. The point is that successive iterations MEASURE
 * DIFFERENTLY — a stub that returned a constant preset would make every
 * render produce an identical distance and hide any bug in the diff path.
 */
function presetForTurn(n: number) {
  const t = n % 6;
  return {
    ...DEFAULT_PRESET,
    harmonicity: 1 + t * 0.7,
    modulationIndex: 2 + t * 2.5,
    carrierFm: { ...DEFAULT_PRESET.carrierFm, index: 1 + t },
    modulatorFm: { ...DEFAULT_PRESET.modulatorFm, index: 1 + (t % 3) },
  };
}

const NOTES = [
  "Starting from a mid-bright bell and widening the modulator.",
  "Pushing the index up — expecting more upper harmonics in the attack.",
  "Backing brightness off and letting the release ring longer.",
  "Detuning harmonicity off-integer for a metallic edge.",
  "Tightening the amp attack to sharpen the transient.",
  "Settling: this one sounded the most coherent.",
];

const SUGGESTIONS = ["glassier", "more punch", "hollow it out", "make it a bass", "let it breathe"];

/**
 * Build a fake Anthropic message.
 *
 * `force` mirrors tool_choice: the refine loop demands a tool call, while chat
 * may answer in prose. Honoring that distinction is what makes the stub
 * exercise BOTH client paths — {kind:"render"} and {kind:"message"} — rather
 * than only the happy one.
 */
export function fakeClaudeMessage(plan: FakePlan): { content: unknown; stop_reason: string | null } {
  const turn = Array.isArray(plan.messages) ? plan.messages.length : 0;
  const idx = turn % NOTES.length;

  // Deliberately NOT the same string as the rationale below: the UI renders
  // both, so reusing one string makes every turn look duplicated and reads as
  // a rendering bug rather than a stub artifact.
  const text = {
    type: "text",
    text: `[fake-llm] turn ${turn} — offline stub, no model was called.`,
  };

  if (!plan.force && turn % 4 === 3) {
    // Chat turn answering in prose — no tool call. Exercises the branch where
    // the client gets a message step and no render is scheduled.
    return { content: [text], stop_reason: "end_turn" };
  }

  return {
    content: [
      text,
      {
        type: "tool_use",
        id: fakeToolUseId(turn),
        name: "propose_preset",
        input: {
          preset: presetForTurn(turn),
          rationale: NOTES[idx],
          suggestions: SUGGESTIONS.slice(0, SUGGESTION_COUNT),
        },
      },
    ],
    stop_reason: "tool_use",
  };
}
