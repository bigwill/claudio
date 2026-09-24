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

/** iterations_remaining from the newest render tool_result, or null. */
function lastIterationsRemaining(messages: unknown[]): number | null {
  const last = messages[messages.length - 1] as { role?: string; content?: unknown } | undefined;
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return null;
  for (const b of last.content as Array<{ type?: string; content?: unknown }>) {
    if (b.type !== "tool_result" || typeof b.content !== "string") continue;
    try {
      const r = JSON.parse(b.content) as { iterations_remaining?: number };
      if (typeof r.iterations_remaining === "number") return r.iterations_remaining;
    } catch {
      // not JSON: not a render result
    }
  }
  return null;
}

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

  // The iteration budget is spent: finalize, as the real prompt demands.
  if (lastIterationsRemaining(plan.messages) === 0) {
    return {
      content: [
        text,
        {
          type: "tool_use",
          id: fakeToolUseId(turn),
          name: "finalize",
          input: { preset: presetForTurn(turn), rationale: "Settling: this one sounded the most coherent.", suggestions: SUGGESTIONS.slice(0, SUGGESTION_COUNT) },
        },
      ],
      stop_reason: "tool_use",
    };
  }

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

// ---------------------------------------------------------------------------
// Band turns (slice 5): keyword defaults, so the whole band loop runs offline.
// "busier" includes an accent (plan: the summary shows X).
// ---------------------------------------------------------------------------

type Msg = { role: string; content: unknown };

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const text = (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text.includes("[band snapshot]")) return text;
  }
  return "";
}

export function fakeBandMessage(role: "drums" | "bass" | "keys", messages: Msg[]): { content: unknown; stop_reason: string } {
  const text = lastUserText(messages);
  const notes = text.split("\n").filter((l) => l.startsWith("[producer"));
  const note = (notes.at(-1) ?? "").toLowerCase();
  const turn = messages.filter((m) => m.role === "assistant").length;
  const use = (name: string, input: Record<string, unknown>) => ({
    content: [{ type: "tool_use", id: `toolu_fakeband${role}${String(turn).padStart(4, "0")}`, name, input }],
    stop_reason: "tool_use",
  });

  if (note.includes("?")) return use("just_reply", { say: "Happy where it sits. Say the word and I'll move." });

  if (role === "drums") {
    const hat = Array.from({ length: 16 }, (_, step) => ({ step, voice: step === 14 ? "openhat" : "hat", vel: 0.55, accent: step % 4 === 0 }));
    const hits = [0, 6, 8, 11].map((step) => ({ step, voice: "kick", vel: 0.95, accent: step === 0 })).concat(
      [4, 12].map((step) => ({ step, voice: "snare", vel: 0.8, accent: false })),
      hat,
    );
    return use("set_drum_pattern", { say: "Sixteenth hats, a kick push into 3.", lengthBars: 1, hits });
  }

  if (/glass|bright|dark|warm|mellow|shimmer|sound|tone/.test(note)) {
    const current = text.match(/^Your sound: (.+)\n(\{.*\})$/m);
    const preset = current ? (JSON.parse(current[2]) as Record<string, unknown>) : { ...DEFAULT_PRESET };
    const brighter = !/dark|warm|mellow/.test(note);
    const mi = Number(preset.modulationIndex ?? 4);
    return use("set_sound", {
      say: brighter ? "More shimmer on top." : "Rounded it off.",
      preset: {
        ...preset,
        name: `${current?.[1] ?? "Sound"} (${brighter ? "glassier" : "warmer"})`,
        modulationIndex: Math.max(0, mi + (brighter ? 4 : -3)),
        harmonicity: brighter ? 3.5 : preset.harmonicity,
      },
    });
  }

  const eighths = [0, 2, 4, 6, 8, 10, 12, 14];
  const notesOut =
    role === "bass"
      ? eighths.map((step) => ({ step, deg: step === 6 || step === 14 ? 4 : 0, len: 1, vel: 0.8, accent: step === 0 || step === 8 }))
      : eighths.flatMap((step) => [0, 2, 4].map((deg) => ({ step, deg, len: 1, vel: 0.6, accent: step === 0 })));
  return use("set_pattern", { say: role === "bass" ? "Eighths on the root, a fifth at the ends." : "Eighth-note stabs.", lengthBars: 1, notes: notesOut });
}
