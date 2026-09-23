/**
 * Slice 1b spikes: real-model measurements taken before the band is built.
 *
 * `bandTurn` sends one band turn to Sonnet 5 with the plan's request shape
 * (strict tools, tool_choice any, low effort) and returns latency plus the
 * clamped pattern, so the part can be played in the spike page. It refuses
 * while CLAUDIO_FAKE_LLM=1: real calls go through `scripts/spike-1b.mjs`, which
 * unsets the flag and always restores it.
 *
 * `designReport` summarizes one design session for the Opus 5.5 spike: which
 * tool each assistant turn called (or none), and the measured distances.
 *
 * Spike code: deleted or folded into llm.ts / prompts in slice 5.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";

import { clampPattern, summarizePattern, type PitchedRole } from "../src/shared/pattern";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import { fakeLlmEnabled } from "./fakeClaude";
import { decodeContent } from "./model/messages";

const BAND_MODEL = "claude-sonnet-5";
const BAND_TIMEOUT_MS = 30_000;

const noteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["step", "deg", "len", "vel", "accent"],
  properties: {
    step: { type: "integer", description: "0-based sixteenth step within the part (0..lengthBars*16-1)" },
    deg: { type: "integer", description: "Chord-relative scale degree: 0 root, 2 third, 4 fifth, 7 root an octave up; negatives go down" },
    len: { type: "integer", description: "Length in sixteenth steps" },
    vel: { type: "number", description: "Velocity 0..1" },
    accent: { type: "boolean", description: "Accent: +0.25 velocity, for push" },
  },
} as const;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "set_pattern",
    description: "Replace your part. It lands at the next loop line while the band keeps playing.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["say", "lengthBars", "notes"],
      properties: {
        say: { type: "string", description: "One short line to the producer about what you changed" },
        lengthBars: { type: "integer", enum: [1, 2, 4], description: "Part length in bars; it repeats" },
        notes: { type: "array", items: noteSchema },
      },
    },
  },
  {
    name: "just_reply",
    description: "Answer without changing your part. Never use this for a note about your part.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["say"],
      properties: { say: { type: "string" } },
    },
  },
];

const SYSTEM = `You are a musician in a small band with a human producer, playing a looped section that never stops.
You play one instrument through a step sequencer. The loop has 16 sixteenth-note steps per bar.
Pitches are chord-relative scale degrees: degree 0 is the current chord's root, 2 its third, 4 its fifth, 7 the root an octave up, and negatives go down. Because degrees are chord-relative, a 1-bar part follows the chords automatically.
Accents add push. Prefer short parts (1 or 2 bars) that repeat.
A note from the producer about your part must change your part: answer it with set_pattern, and say one short line about what you did.
Example: "@bass steadier" → set_pattern {lengthBars:1, notes:[{step:0,deg:0,len:3,vel:0.9,accent:true},{step:8,deg:0,len:3,vel:0.8,accent:false}], say:"Roots on 1 and 3, nothing fancy."}`;

const ROLE: Record<PitchedRole, string> = {
  bass: "You are the bassist (monophonic, one note per step). Lock to the kick; leave the top end to keys.",
  keys: "You are the keys player (up to 4 notes per step). Voice chords with degrees 0/2/4, stabs or sustained; leave room for the bass and the producer.",
};

export const bandTurn = internalAction({
  args: { role: v.union(v.literal("bass"), v.literal("keys")), snapshot: v.string(), note: v.string() },
  returns: v.any(),
  handler: async (_ctx, args) => {
    if (fakeLlmEnabled()) throw new Error("spikes:bandTurn makes real calls; run it through scripts/spike-1b.mjs");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set on this deployment");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BAND_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: controller.signal,
        body: JSON.stringify({
          model: BAND_MODEL,
          max_tokens: 8000,
          thinking: { type: "adaptive" },
          output_config: { effort: "low" },
          system: [{ type: "text", text: `${SYSTEM}\n\n${ROLE[args.role]}` }],
          tools: TOOLS,
          tool_choice: { type: "any" },
          messages: [{ role: "user", content: `${args.snapshot}\n\n[producer → @${args.role}] ${args.note}` }],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 600)}`);
      const msg = (await res.json()) as Anthropic.Message;
      const ms = Date.now() - t0;
      const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const set = calls.find((c) => c.name === "set_pattern");
      const pattern = set ? clampPattern(args.role, set.input) : null;
      return {
        ms,
        stopReason: msg.stop_reason,
        usage: msg.usage,
        tools: calls.map((c) => c.name),
        say: calls.map((c) => (c.input as { say?: string }).say ?? "").join(" / "),
        rawNoteCount: set ? ((set.input as { notes?: unknown[] }).notes ?? []).length : 0,
        pattern,
        summary: pattern ? summarizePattern(args.role, pattern) : null,
      };
    } finally {
      clearTimeout(timer);
    }
  },
});

export const designReport = internalQuery({
  args: { slug: v.string() },
  returns: v.any(),
  handler: async (ctx, { slug }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!session) return null;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", session._id))
      .take(200);
    const turns = messages
      .filter((m) => m.role === "assistant")
      .map((m) => {
        const content = decodeContent(m.content);
        const blocks = Array.isArray(content) ? (content as Array<{ type: string; name?: string }>) : [];
        return blocks.find((b) => b.type === "tool_use")?.name ?? "none";
      });
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_session_iteration", (q) => q.eq("sessionId", session._id))
      .take(50);
    return {
      status: session.status,
      lastError: session.lastError,
      turns,
      noToolTurns: turns.filter((t) => t === "none").length,
      attempts: attempts.map((a) => ({ iteration: a.iteration, name: a.preset.name, distance: a.distance, isFinal: a.isFinal })),
    };
  },
});

// ---------------------------------------------------------------------------
// Replay experiment (1b follow-up): resend one failing design turn N times per
// condition to measure the placeholder rate. Conversation crosses query →
// action as JSON TEXT, because Convex sorts object keys (see model/messages).
// ---------------------------------------------------------------------------

export const replayContext = internalQuery({
  args: { slug: v.string(), beforeSeq: v.number() },
  returns: v.string(),
  handler: async (ctx, { slug, beforeSeq }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!session) throw new Error(`no session ${slug}`);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", session._id).lt("seq", beforeSeq))
      .take(200);
    return JSON.stringify(rows.map((r) => ({ role: r.role, content: decodeContent(r.content) })));
  },
});

type Json = Record<string, unknown>;

/** Move `first` keys to the front and `last` keys to the back, keeping the rest in order. */
function reorder<T extends Json>(o: T, first: string[], last: string[]): T {
  const keys = Object.keys(o);
  const mid = keys.filter((k) => !first.includes(k) && !last.includes(k));
  const out: Json = {};
  for (const k of [...first.filter((k) => k in o), ...mid, ...last.filter((k) => k in o)]) out[k] = o[k];
  return out as T;
}

/** Condition C: rationale before preset, name last, in both the schema and the replayed calls. */
export function reorderSchema(tool: Json): Json {
  const schema = tool.input_schema as Json;
  const props = schema.properties as Json;
  const preset = props.preset as Json;
  const presetProps = reorder(preset.properties as Json, [], ["name"]);
  const newPreset = { ...preset, properties: presetProps, required: Object.keys(presetProps) };
  const topProps = reorder({ ...props, preset: newPreset }, ["rationale"], []);
  const required = Object.keys(topProps).filter((k) => (schema.required as string[]).includes(k));
  return { ...tool, input_schema: { ...schema, properties: topProps, required } };
}

export function reorderCalls(messages: Array<{ role: string; content: unknown }>) {
  return messages.map((m) =>
    m.role !== "assistant" || !Array.isArray(m.content)
      ? m
      : {
          ...m,
          content: (m.content as Json[]).map((b) => {
            if (b.type !== "tool_use") return b;
            const input = b.input as Json;
            const preset = input.preset ? reorder(input.preset as Json, [], ["name"]) : undefined;
            return { ...b, input: reorder(preset ? { ...input, preset } : input, ["rationale"], []) };
          }),
        },
  );
}

export const stripRule10 = (text: string) => text.replace(/\n10\. SEVERAL PEOPLE[\s\S]*$/, "");

const PLACEHOLDER = /^(x|placeholder|tbd|todo|\.+|-+)?$/i;

export const replayTurn = internalAction({
  args: {
    slug: v.string(),
    beforeSeq: v.number(),
    condition: v.union(v.literal("A"), v.literal("B"), v.literal("C")),
    samples: v.number(),
    model: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    if (fakeLlmEnabled()) throw new Error("spikes:replayTurn makes real calls; run it through scripts/replay-1b.mjs");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set on this deployment");
    const { SYSTEM_BLOCKS, TOOLS: DESIGN_TOOLS, MUST_CALL_TOOL_RULE, MAX_TOKENS } = await import("./prompt");

    let messages = JSON.parse(await ctx.runQuery(internal.spikes.replayContext, { slug: args.slug, beforeSeq: args.beforeSeq })) as Array<{ role: string; content: unknown }>;
    let system = SYSTEM_BLOCKS.map((b) => ({ ...b }));
    let tools = DESIGN_TOOLS as unknown as Json[];
    if (args.condition === "B") system = system.map((b) => ({ ...b, text: stripRule10(b.text) }));
    if (args.condition === "C") {
      tools = tools.map((t) => (t.name === "propose_preset" || t.name === "finalize" ? reorderSchema(t) : t));
      messages = reorderCalls(messages);
    }
    const forcedOk = args.model !== "claude-opus-5-5";
    if (!forcedOk) system = [...system, { type: "text" as const, text: MUST_CALL_TOOL_RULE }];

    const one = async () => {
      const t0 = Date.now();
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: args.model,
          max_tokens: MAX_TOKENS,
          thinking: { type: "adaptive" },
          output_config: { effort: "low" },
          system,
          tools,
          tool_choice: forcedOk ? { type: "any", disable_parallel_tool_use: true } : { type: "auto", disable_parallel_tool_use: true },
          messages,
        }),
      });
      if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 300)}` };
      const msg = (await res.json()) as Anthropic.Message;
      const call = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const input = (call?.input ?? {}) as { preset?: Json; rationale?: string };
      const p = input.preset ?? {};
      const name = String(p.name ?? "");
      const rationale = String(input.rationale ?? "");
      const placeholder =
        !call || PLACEHOLDER.test(name.trim()) || PLACEHOLDER.test(rationale.trim()) || Number(p.harmonicity) < 0.25;
      return {
        ms: Date.now() - t0,
        stop: msg.stop_reason,
        tool: call?.name ?? "none",
        name,
        harmonicity: p.harmonicity,
        modulationIndex: p.modulationIndex,
        rationale: rationale.slice(0, 100),
        placeholder,
        thinking: msg.content.some((b) => b.type === "thinking"),
        usage: { in: msg.usage.input_tokens, out: msg.usage.output_tokens },
      };
    };
    const results = await Promise.all(Array.from({ length: args.samples }, one));
    return JSON.stringify(results);
  },
});

/** The finalized preset of a design session, as JSON text (see model/messages on key order). */
export const finalPreset = internalQuery({
  args: { slug: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { slug }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!session) return null;
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_session_iteration", (q) => q.eq("sessionId", session._id))
      .take(50);
    const final = attempts.find((a) => a.isFinal);
    return final ? JSON.stringify({ preset: final.preset, rationale: final.rationale }) : null;
  },
});
