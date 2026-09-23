/**
 * Claudio Band's database (plan §1). The plan's rules, briefly:
 *
 * - Part versions are append-only and the newest one plays; no "current"
 *   pointer. Content versions (starter/agent/pick/design) are rail pips; copies
 *   (history/scene/undo) restate a content version's basedOn.
 * - Each value with its own write rhythm gets its own document: the hot chat
 *   counters live in jamCounters, so a chat insert never re-runs jams.state.
 * - Each conversation has one log (`messages.convoId` is a musician or a design),
 *   stored as JSON text, because Convex sorts object keys and the model must see
 *   its own tool calls exactly as it wrote them.
 * - Library rows are immutable. There is no presence and no heartbeat.
 *
 * Nullable fields are `v.union(v.null(), X)`, never `v.optional(X)`: Convex
 * stores `undefined` as an absent key, and this code tests `=== null`.
 */

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { vFeatureSummary, vPreset, vRenderSpec, vTargetInfo } from "./validators";

const nullable = <T extends Parameters<typeof v.union>[0]>(x: T) => v.union(v.null(), x);

export const vPhase = v.union(v.literal("soundcheck"), v.literal("jam"));
export const vScale = v.union(v.literal("major"), v.literal("minor"), v.literal("dorian"), v.literal("mixolydian"));
export const vMusicianKind = v.union(v.literal("agent"), v.literal("human"));
export const vRole = v.union(v.literal("drums"), v.literal("bass"), v.literal("keys"), v.literal("producer"));
export const vPitchedRole = v.union(v.literal("bass"), v.literal("keys"));
export const vBandStatus = v.union(v.literal("idle"), v.literal("thinking"));
export const vTurnCause = v.union(v.literal("producer"), v.literal("nudge"));
export const vPartSource = v.union(
  v.literal("starter"),
  v.literal("agent"),
  v.literal("pick"),
  v.literal("design"),
  v.literal("history"),
  v.literal("scene"),
  v.literal("undo"),
);
export const vDesignStatus = v.union(
  v.literal("thinking"),
  v.literal("awaiting_render"),
  v.literal("done"),
  v.literal("failed"),
);
export const vDesignOrigin = v.union(v.literal("wav"), v.literal("prompt"));
export const vChatKind = v.union(v.literal("producer"), v.literal("musician"), v.literal("system"), v.literal("nudge"));
export const vLibraryOrigin = v.union(v.literal("starter"), v.literal("designed"), v.literal("tweak"));
export const vLengthBars = v.union(v.literal(1), v.literal(2), v.literal(4));

export const vPitchedNote = v.object({
  step: v.number(),
  deg: v.number(),
  len: v.number(),
  vel: v.number(),
  accent: v.boolean(),
  tie: v.boolean(),
});
export const vDrumHit = v.object({
  step: v.number(),
  voice: v.union(v.literal("kick"), v.literal("snare"), v.literal("hat"), v.literal("openhat")),
  vel: v.number(),
  accent: v.boolean(),
});

/** A scene: each musician's content version and mute, keyed by musician id. */
export const vScene = v.record(v.id("musicians"), v.object({ basedOn: v.number(), muted: v.boolean() }));

export default defineSchema({
  jams: defineTable({
    /** The id in the URL. Not a credential. */
    slug: v.string(),
    phase: vPhase,
    /** "Band reacts" (wave 2 nudges). */
    reactive: v.boolean(),
    bpm: v.number(),
    keyPc: v.number(),
    scale: vScale,
    bars: vLengthBars,
    /** Chord roots as scale degrees, one per bar; ≤ 4. */
    progression: v.array(v.number()),
    scenes: v.object({ A: nullable(vScene), B: nullable(vScene) }),
  }).index("by_slug", ["slug"]),

  /** Hot counters, kept off `jams` so a chat insert never re-runs jams.state. */
  jamCounters: defineTable({
    jamId: v.id("jams"),
    /** Every chat insert reads and writes it: chat order is commit order. */
    chatSeq: v.number(),
    reactionBudget: v.number(),
    lastProducerSeq: v.number(),
  }).index("by_jam", ["jamId"]),

  musicians: defineTable({
    jamId: v.id("jams"),
    kind: vMusicianKind,
    role: vRole,
    name: v.string(),
    muted: v.boolean(),
    status: vBandStatus,
    turnCause: nullable(vTurnCause),
    /** Fencing token for band turns; every terminal branch bumps it. */
    turnSeq: v.number(),
    /** ms epoch; 0 when no turn is in flight. */
    turnDeadline: v.number(),
    /** The last chat seq this musician has read. */
    chatCursor: v.number(),
    /** Set while a design runs; holds the band inbox. */
    activeDesignId: nullable(v.id("designs")),
  })
    .index("by_jam", ["jamId"])
    .index("by_status_deadline", ["status", "turnDeadline"]),

  parts: defineTable({
    musicianId: v.id("musicians"),
    jamId: v.id("jams"),
    version: v.number(),
    basedOn: v.number(),
    /** The basedOn this row replaced (for wave 2 undo); null on the first row. */
    prev: nullable(v.number()),
    /** Mute before a scene recall (wave 2 undo). */
    prevMuted: nullable(v.boolean()),
    /** One mutation stamps all its rows with one txn. */
    txn: v.string(),
    /** Set on undo copies: the txn they reverse. */
    undoes: nullable(v.string()),
    source: vPartSource,
    /** Rail caption: the agent's `say` or the pick name. */
    label: v.string(),
    lengthBars: vLengthBars,
    /** Pitched notes or drum hits; ≤ 256. Empty = lays out. */
    notes: v.union(v.array(vPitchedNote), v.array(vDrumHit)),
    /** The sound; null for the kit. */
    libraryId: nullable(v.id("library")),
  })
    .index("by_musician_version", ["musicianId", "version"])
    /** Content versions (the rail's pips) without scanning every history copy. */
    .index("by_musician_source", ["musicianId", "source", "version"])
    .index("by_jam", ["jamId"]),

  /** A sound-design job: today's measured loop, owned by one musician. */
  designs: defineTable({
    musicianId: v.id("musicians"),
    status: vDesignStatus,
    origin: vDesignOrigin,
    target: nullable(vFeatureSummary),
    /** Filename etc. of the target WAV, for the library's provenance. */
    targetInfo: nullable(vTargetInfo),
    targetAudioId: nullable(v.id("_storage")),
    prompt: nullable(v.string()),
    renderSpec: nullable(vRenderSpec),
    iteration: v.number(),
    /** THE CRUX: the tool_use we owe a tool_result for. */
    pendingToolUseId: nullable(v.string()),
    pendingPresetId: nullable(v.string()),
    /** First caller of claimRender wins the lease. */
    renderOwnerClientId: nullable(v.string()),
    renderLeaseUntil: v.number(),
    /** Lease generation; fences leaseExpired and dedupes client renders. */
    renderAttemptNo: v.number(),
    turnSeq: v.number(),
    turnDeadline: v.number(),
    noToolStrikes: v.number(),
    lastError: nullable(v.string()),
  })
    .index("by_musician", ["musicianId"])
    .index("by_status_deadline", ["status", "turnDeadline"])
    .index("by_render_lease", ["status", "renderLeaseUntil"]),

  /** The Anthropic conversations: a musician's band log or a design's log. */
  messages: defineTable({
    convoId: v.union(v.id("musicians"), v.id("designs")),
    seq: v.number(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    /** JSON text of the content, exactly as sent or returned (see model/messages). */
    content: v.string(),
  }).index("by_convo_seq", ["convoId", "seq"]),

  attempts: defineTable({
    designId: v.id("designs"),
    /** The tool_use id. */
    presetId: v.string(),
    iteration: v.number(),
    preset: vPreset,
    rationale: v.string(),
    features: nullable(vFeatureSummary),
    distance: nullable(v.number()),
    isFinal: v.boolean(),
  })
    .index("by_design_iteration", ["designId", "iteration"])
    .index("by_design_preset", ["designId", "presetId"]),

  /** The band chat. `postChat` is its only writer. */
  chat: defineTable({
    jamId: v.id("jams"),
    seq: v.number(),
    kind: vChatKind,
    fromMusicianId: nullable(v.id("musicians")),
    /** Musician ids (≤ 3); empty means every agent. */
    to: v.array(v.id("musicians")),
    /** The one musician a nudge may trigger. */
    reactor: nullable(v.id("musicians")),
    replyToSeq: nullable(v.number()),
    text: v.string(),
    /** Producer rows: the octave you were playing in when you sent it. */
    octave: nullable(v.number()),
  }).index("by_jam_seq", ["jamId", "seq"]),

  /** Every sound anyone has: starters, designs and tweaks. Immutable rows. */
  library: defineTable({
    name: v.string(),
    role: vPitchedRole,
    preset: vPreset,
    features: nullable(vFeatureSummary),
    origin: vLibraryOrigin,
    /** The WAV filename, the prompt, or "tweak of X". */
    source: v.string(),
    designId: nullable(v.id("designs")),
    fromJamId: nullable(v.id("jams")),
    starterKey: nullable(v.string()),
  })
    .index("by_role", ["role"])
    .index("by_role_jam", ["role", "fromJamId"])
    .index("by_starterKey", ["starterKey"]),

  /**
   * Scripted responses for the fake LLM (CLAUDIO_FAKE_LLM=1). Every read and
   * write through `testing:*` is refused unless the flag is set.
   */
  fakeScripts: defineTable({
    match: v.string(),
    turnIndex: v.number(),
    response: v.any(),
  }).index("by_match_turn", ["match", "turnIndex"]),
});
