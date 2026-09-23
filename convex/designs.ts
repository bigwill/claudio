/**
 * Design jobs (plan §4): the measured sound-design loop, run for one musician
 * during soundcheck. `start` is the only way in; `cancel` ends one early.
 * Browsers render proposals: `renderJob` is what they need, `render.claimRender`
 * decides who, and `render.submitAnalysis` reports back.
 */

import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { beginDesignTurn, endDesign } from "./model/design";
import { discardTurn } from "./model/jam";
import { appendMessage } from "./model/messages";
import { vFeatureSummary, vRenderSpec, vTargetInfo, vPreset } from "./validators";
import { MAX_ITERATIONS } from "../src/shared/protocol";

const vSource = v.union(
  v.object({ kind: v.literal("wav"), features: vFeatureSummary, info: vTargetInfo, audioId: v.union(v.null(), v.id("_storage")) }),
  v.object({ kind: v.literal("prompt"), text: v.string() }),
);

/** Upload slot for the prepared target audio, so the rail can preview it after a reload. */
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const start = mutation({
  args: { musicianId: v.id("musicians"), source: vSource, spec: vRenderSpec },
  returns: v.id("designs"),
  handler: async (ctx, { musicianId, source, spec }) => {
    const m = await ctx.db.get(musicianId);
    if (!m) throw new ConvexError("no such musician");
    if (m.role === "drums") throw new ConvexError("Drums play the kit; there's no sound to design.");
    if (m.activeDesignId !== null) throw new ConvexError(`${m.name} is already designing a sound.`);
    const prompt = source.kind === "prompt" ? source.text.trim().slice(0, 2000) : null;
    if (source.kind === "prompt" && !prompt) throw new ConvexError("Describe the sound first.");
    await discardTurn(ctx, m); // your request wins over a band turn in flight

    const designId = await ctx.db.insert("designs", {
      musicianId,
      status: "thinking",
      origin: source.kind,
      target: source.kind === "wav" ? source.features : null,
      targetInfo: source.kind === "wav" ? source.info : null,
      targetAudioId: source.kind === "wav" ? source.audioId : null,
      prompt,
      renderSpec: spec,
      iteration: 0,
      pendingToolUseId: null,
      pendingPresetId: null,
      renderOwnerClientId: null,
      renderLeaseUntil: 0,
      renderAttemptNo: 0,
      turnSeq: 0,
      turnDeadline: 0,
      noToolStrikes: 0,
      lastError: null,
    });
    await ctx.db.patch(musicianId, { activeDesignId: designId });

    // The opening message is the original loop's, verbatim.
    const text =
      source.kind === "wav"
        ? `The user uploaded "${source.info.filename}" (${source.info.durationSec.toFixed(2)}s @ ${source.info.sampleRate} Hz).\n` +
          `Here is its feature vector:\n\n` +
          "```json\n" +
          JSON.stringify(source.features) +
          "\n```\n\n" +
          `You have ${MAX_ITERATIONS} render iterations. Pick an archetype that explains these ` +
          `features and instantiate it, then call propose_preset. The browser will render it and return a diff.`
        : `There is NO target sample this time. The user asked for a sound in their own words:\n\n` +
          `"${prompt}"\n\n` +
          `Design it from the description. Call propose_preset — the browser will render it and report ` +
          `back the features your patch actually measures, so you can check it against what you intended. ` +
          `There is no distance to minimise here; the user's words are the whole specification. ` +
          `Finalize as soon as the patch matches the description — one proposal is often enough.`;
    await appendMessage(ctx, designId, { role: "user", content: [{ type: "text", text }] });

    const design = (await ctx.db.get(designId))!;
    await beginDesignTurn(ctx, design, Date.now());
    return designId;
  },
});

/** End a design early. Its pending tool_use, if any, is answered so the log stays valid. */
export const cancel = mutation({
  args: { designId: v.id("designs") },
  returns: v.null(),
  handler: async (ctx, { designId }) => {
    const design = await ctx.db.get(designId);
    if (!design || design.status === "done" || design.status === "failed") return null;
    if (design.pendingToolUseId) {
      await appendMessage(ctx, designId, {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: design.pendingToolUseId,
            is_error: true,
            content: "The producer cancelled this design.",
          },
        ],
      });
    }
    await endDesign(ctx, design, { kind: "failed", why: "cancelled" });
    return null;
  },
});

/** What a browser needs to render the pending proposal. */
export const renderJob = query({
  args: { designId: v.id("designs") },
  returns: v.union(
    v.null(),
    v.object({
      presetId: v.string(),
      preset: vPreset,
      spec: vRenderSpec,
      target: v.union(v.null(), vFeatureSummary),
      attemptNo: v.number(),
      ownerClientId: v.union(v.null(), v.string()),
      leaseUntil: v.number(),
    }),
  ),
  handler: async (ctx, { designId }) => {
    const d = await ctx.db.get(designId);
    if (!d || d.status !== "awaiting_render" || !d.pendingPresetId || !d.renderSpec) return null;
    const attempt = await ctx.db
      .query("attempts")
      .withIndex("by_design_preset", (q) => q.eq("designId", designId).eq("presetId", d.pendingPresetId!))
      .first();
    if (!attempt) return null;
    return {
      presetId: d.pendingPresetId,
      preset: attempt.preset,
      spec: d.renderSpec,
      target: d.target,
      attemptNo: d.renderAttemptNo,
      ownerClientId: d.renderOwnerClientId,
      leaseUntil: d.renderLeaseUntil,
    };
  },
});
