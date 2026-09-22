/**
 * Creating and reading sessions.
 *
 * `state` is the subscription every contributor lives on. `attempts` is split
 * off it deliberately: Convex re-sends a whole query result on every change, and
 * a session's attempts carry full presets and feature vectors, so folding them
 * into the hot document would re-ship all of them to everyone on every status
 * flip and every lease claim.
 */

import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { vFeatureSummary, vRenderSpec, vTargetInfo } from "./validators";
import { addChat, beginTurn } from "./model/turn";
import { appendMessage } from "./model/messages";
import { bySlug, freshSessionFields, isStarted } from "./model/sessions";
import { sanitizeNickname } from "../src/shared/protocol";

const vAuthor = v.object({
  clientId: v.string(),
  nickname: v.string(),
  color: v.string(),
});

/**
 * The reactive document.
 *
 * `pendingToolUseId` is deliberately NOT exposed: it is an Anthropic identifier
 * the browser can do nothing useful with, and the client already has
 * `pendingPresetId` for everything it needs to decide.
 */
export const state = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const s = await bySlug(ctx, args.slug);
    if (!s) return null;

    const chat = await ctx.db
      .query("chat")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", s._id))
      .order("desc")
      .take(100);

    const queuedCount = chat.filter((c) => c.status === "queued").length;

    return {
      sessionId: s._id,
      slug: s.slug,
      status: s.status,
      statusSince: s.statusSince,
      target: s.target,
      targetInfo: s.targetInfo,
      hasTargetAudio: s.targetAudioId !== null,
      promptText: s.promptText,
      renderSpec: s.renderSpec,
      iteration: s.iteration,
      maxIterations: s.maxIterations,
      bestPresetId: s.bestPresetId,
      bestDistance: s.bestDistance,
      lastError: s.lastError,
      lastErrorRetryable: s.lastErrorRetryable,
      turnStartedBy: s.turnStartedBy,
      // Render duty. leaseUntil is an ABSOLUTE deadline on purpose: a lease
      // lapsing is not a database write, so no subscription will ever fire for
      // it — the client has to watch the clock itself.
      render: s.pendingPresetId
        ? {
            presetId: s.pendingPresetId,
            ownerClientId: s.renderOwnerClientId,
            leaseUntil: s.renderLeaseUntil,
            attemptNo: s.renderAttemptNo,
          }
        : null,
      chat: chat.map((c) => ({
        id: c._id,
        seq: c.seq,
        kind: c.kind,
        status: c.status,
        text: c.text,
        authorClientId: c.authorClientId,
        nickname: c.nickname,
        color: c.color,
        aboutPresetId: c.aboutPresetId,
        suggestions: c.suggestions,
      })),
      queuedCount,
    };
  },
});

export const attempts = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const s = await bySlug(ctx, args.slug);
    if (!s) return [];
    const rows = await ctx.db
      .query("attempts")
      .withIndex("by_session_iteration", (q) => q.eq("sessionId", s._id))
      .order("asc")
      .collect();
    return rows.map((a) => ({
      presetId: a.presetId,
      iteration: a.iteration,
      preset: a.preset,
      rationale: a.rationale,
      features: a.features,
      distance: a.distance,
      askedByClientId: a.askedByClientId,
      measuredByClientId: a.measuredByClientId,
      isFinal: a.isFinal,
    }));
  },
});

/** The stored target audio, so a joiner can actually hear what's being matched. */
export const targetAudioUrl = query({
  args: { slug: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const s = await bySlug(ctx, args.slug);
    if (!s?.targetAudioId) return null;
    return await ctx.storage.getUrl(s.targetAudioId);
  },
});

/**
 * Reserve a slug. Idempotent: the browser already put this id in the URL, so a
 * retry across a reconnect must not mint a second session.
 */
export const create = mutation({
  args: { slug: v.string(), author: vAuthor },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await bySlug(ctx, args.slug);
    if (existing) return null;
    await ctx.db.insert("sessions", freshSessionFields(args.slug, Date.now()));
    return null;
  },
});

/** Upload slot for the prepared target audio (16-bit PCM, ~150KB). */
export const generateTargetUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const setTarget = mutation({
  args: {
    slug: v.string(),
    author: vAuthor,
    features: vFeatureSummary,
    info: vTargetInfo,
    spec: vRenderSpec,
    audioId: v.union(v.null(), v.id("_storage")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await bySlug(ctx, args.slug);
    if (!session) throw new ConvexError({ code: "no-session" });

    // A shared session must never be wiped out from under the people in it.
    // Starting over is what `fork` is for.
    if (await isStarted(ctx, session)) {
      throw new ConvexError({
        code: "already-started",
        message: "This session has already been started. Fork it to try something else.",
      });
    }

    const now = Date.now();
    const nickname = sanitizeNickname(args.author.nickname);

    await ctx.db.patch(session._id, {
      target: args.features,
      targetInfo: args.info,
      targetAudioId: args.audioId,
      renderSpec: args.spec,
      statusSince: now,
    });
    const fresh = (await ctx.db.get(session._id))!;

    await addChat(ctx, fresh, {
      kind: "system",
      text: `${nickname} set the target: ${args.info.filename}`,
    });

    await appendMessage(ctx, fresh, {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `The user uploaded "${args.info.filename}" (${args.info.durationSec.toFixed(2)}s @ ${args.info.sampleRate} Hz).\n` +
            `Here is its feature vector:\n\n` +
            "```json\n" +
            JSON.stringify(args.features) +
            "\n```\n\n" +
            `You have ${fresh.maxIterations} render iterations. Pick an archetype that explains these ` +
            `features and instantiate it, then call propose_preset. The browser will render it and return a diff.`,
        },
      ],
    });

    await beginTurn(ctx, fresh, {
      by: args.author.clientId,
      force: true,
      isFirstProposal: true,
      now,
    });
    return null;
  },
});

/**
 * Start from a description instead of a sample ("a glassy bell, quite short").
 *
 * Same loop, minus the reference: the browser still renders and measures each
 * proposal, so the agent still learns what it actually built — it just has
 * nothing to compare against, and no distance to minimise. Here the user's words
 * ARE the specification.
 */
export const startFromPrompt = mutation({
  args: {
    slug: v.string(),
    author: vAuthor,
    prompt: v.string(),
    spec: vRenderSpec,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await bySlug(ctx, args.slug);
    if (!session) throw new ConvexError({ code: "no-session" });
    if (await isStarted(ctx, session)) {
      throw new ConvexError({
        code: "already-started",
        message: "This session has already been started. Fork it to try something else.",
      });
    }

    const now = Date.now();
    const prompt = args.prompt.trim().slice(0, 2000);
    if (!prompt) throw new ConvexError({ code: "empty-prompt" });
    const nickname = sanitizeNickname(args.author.nickname);

    await ctx.db.patch(session._id, {
      promptText: prompt,
      renderSpec: args.spec,
      statusSince: now,
    });
    const fresh = (await ctx.db.get(session._id))!;

    await addChat(ctx, fresh, { kind: "system", text: `${nickname} asked for: ${prompt}` });

    await appendMessage(ctx, fresh, {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `There is NO target sample this time. The user asked for a sound in their own words:\n\n` +
            `"${prompt}"\n\n` +
            `Design it from the description. Call propose_preset — the browser will render it and report ` +
            `back the features your patch actually measures, so you can check it against what you intended. ` +
            `There is no distance to minimise here; the user's words are the whole specification. ` +
            `Finalize as soon as the patch matches the description — one proposal is often enough.`,
        },
      ],
    });

    await beginTurn(ctx, fresh, {
      by: args.author.clientId,
      force: true,
      isFirstProposal: true,
      now,
    });
    return null;
  },
});

/**
 * Branch a new session from this one, carrying the target and a chosen preset.
 *
 * This exists so "I like this, let me take it somewhere" has an answer that
 * isn't "wipe what everyone else is working on". It also turns the
 * already-started rejection above from a dead end into a signpost.
 */
export const fork = mutation({
  args: {
    fromSlug: v.string(),
    newSlug: v.string(),
    author: vAuthor,
    presetId: v.union(v.null(), v.string()),
  },
  // Returns the new slug rather than null, so the caller can tell success from
  // the null a failed mutation wrapper resolves to.
  returns: v.string(),
  handler: async (ctx, args) => {
    const from = await bySlug(ctx, args.fromSlug);
    if (!from) throw new ConvexError({ code: "no-session" });
    if (await bySlug(ctx, args.newSlug)) return args.newSlug; // idempotent

    const now = Date.now();
    const id = await ctx.db.insert("sessions", {
      ...freshSessionFields(args.newSlug, now),
      target: from.target,
      targetInfo: from.targetInfo,
      targetAudioId: from.targetAudioId,
      promptText: from.promptText,
      renderSpec: from.renderSpec,
    });
    const fresh = (await ctx.db.get(id))!;

    const seed = args.presetId
      ? await ctx.db
          .query("attempts")
          .withIndex("by_session_preset", (q) =>
            q.eq("sessionId", from._id).eq("presetId", args.presetId!),
          )
          .first()
      : null;

    await addChat(ctx, fresh, {
      kind: "system",
      text: seed
        ? `${sanitizeNickname(args.author.nickname)} forked this from "${seed.preset.name}".`
        : `${sanitizeNickname(args.author.nickname)} forked this session.`,
    });

    // Carry the preset across as an attempt so it is immediately playable and
    // loadable in the new session, without having to re-derive it.
    if (seed) {
      await ctx.db.insert("attempts", {
        sessionId: id,
        presetId: seed.presetId,
        iteration: 0,
        preset: seed.preset,
        rationale: seed.rationale,
        features: seed.features,
        distance: seed.distance,
        askedByClientId: null,
        measuredByClientId: null,
        isFinal: false,
      });
      await ctx.db.patch(id, { bestPresetId: seed.presetId, bestDistance: seed.distance });
    }

    /**
     * Seed the conversation, but do NOT start a turn.
     *
     * A fork is idle until someone asks it for something — but when they do, the
     * agent needs to already know what it is looking at. Without this the first
     * chat message would arrive with no target, no preset and no history, and the
     * agent would be designing blind while the UI showed a target right there.
     */
    const intro = from.target
      ? `This session was forked from an earlier one. The target sample was ` +
        `"${from.targetInfo?.filename ?? "a sample"}", and here is its feature vector:\n\n` +
        "```json\n" +
        JSON.stringify(from.target) +
        "\n```\n\n"
      : from.promptText
        ? `This session was forked from an earlier one, which started from the description ` +
          `"${from.promptText}".\n\n`
        : // Forking a session nobody had started yet. Reachable through the API
          // even though the UI only offers fork on an iteration, and saying
          // 'the description ""' would be worse than saying nothing.
          `This session was forked from an earlier one, which had no target sample ` +
          `and no description.\n\n`;

    const startingPoint = seed
      ? `The starting point is the preset "${seed.preset.name}":\n\n` +
        "```json\n" +
        JSON.stringify(seed.preset) +
        "\n```\n\n" +
        `Its designer's note was: ${seed.rationale}\n\n`
      : "";

    await appendMessage(ctx, fresh, {
      role: "user",
      content: [
        {
          type: "text",
          text:
            intro +
            startingPoint +
            `Nothing has been asked for yet — wait for the user's instruction, then work from here.`,
        },
      ],
    });
    return args.newSlug;
  },
});
