/**
 * The database that replaces SessionDO's two SQLite tables.
 *
 * The Durable Object kept `history: Attempt[]` inline in one meta row, because a
 * single-threaded actor gets serialization for free. Under Convex's optimistic
 * concurrency that inlining is actively harmful: recording a measurement would
 * rewrite the same document that presence heartbeats and turn commits also touch,
 * manufacturing write conflicts between operations that have nothing to do with
 * each other. So anything with its own write cadence gets its own table.
 *
 * `sessions` is the hot document — status transitions and lease claims write it
 * constantly — so it holds scalars only, and everything that grows lives beside it.
 */

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  vChatKind,
  vChatStatus,
  vFeatureSummary,
  vPreset,
  vRenderSpec,
  vStatus,
  vTargetInfo,
} from "./validators";

/**
 * Note on nullable fields throughout: `v.union(v.null(), X)`, never
 * `v.optional(X)`. Convex documents cannot hold `undefined` — `{a: undefined}` is
 * stored as `{}` — and the ported logic tests `=== null` (e.g. `bestDistance`,
 * `pendingToolUseId`). `v.optional` would mean "key absent", which reads back as
 * `undefined` and quietly fails those comparisons.
 */
export default defineSchema({
  sessions: defineTable({
    /** The 12-char Crockford id in the URL. Minted client-side; NOT auth. */
    slug: v.string(),

    // --- ported from SessionDO's Meta ------------------------------------
    status: vStatus,
    statusSince: v.number(),
    target: v.union(v.null(), vFeatureSummary),
    targetInfo: v.union(v.null(), vTargetInfo),
    /** Convex storage id for the prepared target audio, so joiners can hear it. */
    targetAudioId: v.union(v.null(), v.id("_storage")),
    /** Set for prompt-started sessions; also makes "already started" observable. */
    promptText: v.union(v.null(), v.string()),
    iteration: v.number(),
    maxIterations: v.number(),
    bestPresetId: v.union(v.null(), v.string()),
    bestDistance: v.union(v.null(), v.number()),
    /** THE CRUX: the tool_use we owe a tool_result for. */
    pendingToolUseId: v.union(v.null(), v.string()),
    pendingPresetId: v.union(v.null(), v.string()),

    /**
     * Pinned once, at setTarget/startFromPrompt, and used verbatim by every
     * browser that renders for this session. Tone.Offline takes sampleRate
     * explicitly, so a fixed spec makes renders comparable across machines.
     */
    renderSpec: v.union(v.null(), vRenderSpec),

    // --- turn control (replaces the DO's single-threaded serialization) ---
    /**
     * The fencing token, and the entire answer to "actions are not
     * transactional". Every terminal branch bumps it; commit/fail/watchdog
     * no-op unless their token still matches. An action that overran its lease
     * therefore cannot append a tool_use into a log that has moved on.
     */
    turnSeq: v.number(),
    /** ms epoch; 0 when no turn is in flight. */
    turnDeadline: v.number(),
    /** Who triggered this turn — inherits render duty for its proposal. */
    turnStartedBy: v.union(v.null(), v.string()),
    /** tool_choice: "any" in the refine loop, "auto" in chat. */
    turnForce: v.boolean(),
    turnIsFirstProposal: v.boolean(),
    turnJobId: v.union(v.null(), v.id("_scheduled_functions")),

    // --- render lease ----------------------------------------------------
    renderOwnerClientId: v.union(v.null(), v.string()),
    renderLeaseUntil: v.number(),
    /**
     * Lease generation. The client's dedupe key is `${presetId}#${attemptNo}`,
     * never presetId alone — otherwise a client that tried once and failed would
     * permanently blacklist the very preset it may later need to rescue.
     */
    renderAttemptNo: v.number(),

    // --- bookkeeping -----------------------------------------------------
    msgSeq: v.number(),
    chatSeq: v.number(),
    lastError: v.union(v.null(), v.string()),
    lastErrorRetryable: v.boolean(),
  })
    .index("by_slug", ["slug"])
    // Watchdog scan for turns whose action died without committing.
    .index("by_status_deadline", ["status", "turnDeadline"])
    // Watchdog scan for renders nobody completed. Without this, awaiting_render
    // has no recovery at all: a failed leaseExpired job is never re-run.
    .index("by_render_lease", ["status", "renderLeaseUntil"]),

  /**
   * The Anthropic conversation, append-only.
   *
   * `content` is v.any() deliberately. Hand-writing Anthropic's block union
   * (text / thinking + signature / redacted_thinking / tool_use / tool_result /
   * whatever ships next quarter) would reject new block types after an SDK bump
   * and brick every live session — and there is no trust argument for validating
   * it, since it is server-authored inside the turn action and never
   * client-supplied. The assistant turn must be persisted VERBATIM or the next
   * request breaks.
   */
  messages: defineTable({
    sessionId: v.id("sessions"),
    seq: v.number(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.any(),
  }).index("by_session_seq", ["sessionId", "seq"]),

  attempts: defineTable({
    sessionId: v.id("sessions"),
    /** The Anthropic tool_use id. Unique per proposal, so no id minting in a mutation. */
    presetId: v.string(),
    iteration: v.number(),
    preset: vPreset,
    rationale: v.string(),
    features: v.union(v.null(), vFeatureSummary),
    distance: v.union(v.null(), v.number()),
    /** Attribution only, both of these. Spoofable; never used for access control. */
    askedByClientId: v.union(v.null(), v.string()),
    measuredByClientId: v.union(v.null(), v.string()),
    isFinal: v.boolean(),
  })
    .index("by_session_iteration", ["sessionId", "iteration"])
    .index("by_session_preset", ["sessionId", "presetId"]),

  /**
   * Persisted, multi-author chat — and the queue.
   *
   * Deliberately not two tables. A queued message is just a row with
   * status:"queued", so the UI already has it (attributed, in order, with the
   * preset its author was looking at) and the drain is "oldest queued row".
   * Nothing has to be reconciled between a display list and a work list.
   */
  chat: defineTable({
    sessionId: v.id("sessions"),
    seq: v.number(),
    kind: vChatKind,
    status: vChatStatus,
    authorClientId: v.union(v.null(), v.string()),
    /** Sanitized server-side: this gets spliced into the prompt as `[nickname]`. */
    nickname: v.union(v.null(), v.string()),
    color: v.union(v.null(), v.string()),
    text: v.string(),
    /** Which preset the author was looking at — turns a stale referent into context. */
    aboutPresetId: v.union(v.null(), v.string()),
    suggestions: v.array(v.string()),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    .index("by_session_status_seq", ["sessionId", "status", "seq"]),

  /**
   * Who is here. Its own table AND its own subscription: a heartbeat must touch
   * nothing else, or the read set joins every live turn commit's conflict domain,
   * and a 10s heartbeat per contributor would otherwise re-push every preset in
   * the session to everyone.
   */
  presence: defineTable({
    sessionId: v.id("sessions"),
    clientId: v.string(),
    nickname: v.string(),
    color: v.string(),
    joinedAt: v.number(),
    lastSeen: v.number(),
    /**
     * ms epoch through which this client expects to be playing notes.
     * Tone.Offline swaps the global Tone context, so drafting someone as renderer
     * mutes them mid-phrase — this is how render duty prefers a silent lurker.
     */
    playingUntil: v.number(),
  })
    .index("by_session_client", ["sessionId", "clientId"])
    .index("by_session_lastSeen", ["sessionId", "lastSeen"]),
});
