/**
 * Jams: creation, the state subscription, and the producer's jam-wide direct
 * mutations (plan §1, §4). No LLM here.
 *
 * `state` never reads jamCounters (a chat insert would re-run it) and never
 * reads the clock (a query doesn't re-run on time passing); lease expiry and
 * "thinking… Ns" are computed on the client.
 */

import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { anyDesignRunning, appendPart, clampBpm, contentRow, discardTurn, jamBySlug, musiciansOf, newestPart, newTxn } from "./model/jam";
import { DEFAULT_SOUNDS, STARTER_PARTS, STARTER_SOUNDS } from "../src/shared/starters";
import {
  vBandStatus,
  vChatKind,
  vDesignOrigin,
  vDesignStatus,
  vDrumHit,
  vLengthBars,
  vMusicianKind,
  vPartSource,
  vPhase,
  vPitchedNote,
  vRole,
  vScale,
  vTurnCause,
} from "./schema";
import { vPreset, vRenderSpec } from "./validators";

const vSceneName = v.union(v.literal("A"), v.literal("B"));
const nullable = <T extends Parameters<typeof v.union>[0]>(x: T) => v.union(v.null(), x);

/** The client's main contract: one strip. */
const vStrip = v.object({
  _id: v.id("musicians"),
  kind: vMusicianKind,
  role: vRole,
  name: v.string(),
  muted: v.boolean(),
  status: vBandStatus,
  turnCause: nullable(vTurnCause),
  turnDeadline: v.number(),
  activeDesignId: nullable(v.id("designs")),
  part: v.object({
    version: v.number(),
    basedOn: v.number(),
    source: vPartSource,
    label: v.string(),
    lengthBars: vLengthBars,
    notes: v.union(v.array(vPitchedNote), v.array(vDrumHit)),
    libraryId: nullable(v.id("library")),
    sound: nullable(v.object({ name: v.string(), preset: vPreset })),
  }),
  design: nullable(
    v.object({
      _id: v.id("designs"),
      status: vDesignStatus,
      origin: vDesignOrigin,
      iteration: v.number(),
      pendingPresetId: nullable(v.string()),
      renderOwnerClientId: nullable(v.string()),
      renderLeaseUntil: v.number(),
      renderAttemptNo: v.number(),
      renderSpec: nullable(vRenderSpec),
      attempts: v.array(
        v.object({
          presetId: v.string(),
          iteration: v.number(),
          preset: vPreset,
          rationale: v.string(),
          distance: nullable(v.number()),
          isFinal: v.boolean(),
        }),
      ),
    }),
  ),
});

const vState = v.object({
  jam: v.object({
    _id: v.id("jams"),
    slug: v.string(),
    phase: vPhase,
    reactive: v.boolean(),
    bpm: v.number(),
    keyPc: v.number(),
    scale: vScale,
    bars: vLengthBars,
    progression: v.array(v.number()),
    scenesSaved: v.object({ A: v.boolean(), B: v.boolean() }),
    activeScene: nullable(vSceneName),
  }),
  musicians: v.array(vStrip),
});

const vChatRow = v.object({
  seq: v.number(),
  kind: vChatKind,
  fromMusicianId: nullable(v.id("musicians")),
  to: v.array(v.id("musicians")),
  reactor: nullable(v.id("musicians")),
  replyToSeq: nullable(v.number()),
  text: v.string(),
  octave: nullable(v.number()),
});

/** Upsert the starter library by starterKey. Library rows are immutable, so an existing key is left alone. */
async function upsertStarters(ctx: MutationCtx): Promise<Map<string, Id<"library">>> {
  const ids = new Map<string, Id<"library">>();
  for (const s of STARTER_SOUNDS) {
    const existing = await ctx.db
      .query("library")
      .withIndex("by_starterKey", (q) => q.eq("starterKey", s.starterKey))
      .unique();
    ids.set(
      s.starterKey,
      existing?._id ??
        (await ctx.db.insert("library", {
          name: s.name,
          role: s.role,
          preset: s.preset,
          features: null,
          origin: "starter",
          source: s.source,
          designId: null,
          fromJamId: null,
          starterKey: s.starterKey,
        })),
    );
  }
  return ids;
}

/**
 * Create a jam: starters upserted, 4 musicians (3 agents with v1 starter
 * parts, and you with a v1 sound part), soundcheck phase. No automatic first
 * turn. Idempotent on slug, since the browser mints it before any round trip.
 */
export const create = mutation({
  args: {
    slug: v.string(),
    /** Test jams run at bpm 200 and 1 bar (plan: Testing story, layer 3). Only used at creation. */
    bpm: v.optional(v.number()),
    bars: v.optional(v.union(v.literal(1), v.literal(2), v.literal(4))),
  },
  returns: v.id("jams"),
  handler: async (ctx, { slug, bpm, bars }) => {
    const existing = await jamBySlug(ctx, slug);
    if (existing) return existing._id;
    const lib = await upsertStarters(ctx);
    const jamId = await ctx.db.insert("jams", {
      slug,
      phase: "soundcheck",
      reactive: true,
      bpm: bpm ? clampBpm(bpm) : 96,
      keyPc: 2,
      scale: "minor",
      bars: bars ?? 4,
      progression: [0, 5, 2, 6],
      scenes: { A: null, B: null },
    });
    await ctx.db.insert("jamCounters", { jamId, chatSeq: 0, reactionBudget: 0, lastProducerSeq: 0 });

    const txn = newTxn();
    const strips = [
      { kind: "human", role: "producer", name: "you", part: { lengthBars: 1, notes: [] }, sound: DEFAULT_SOUNDS.you },
      { kind: "agent", role: "drums", name: "drums", part: STARTER_PARTS.drums, sound: null },
      { kind: "agent", role: "bass", name: "bass", part: STARTER_PARTS.bass, sound: DEFAULT_SOUNDS.bass },
      { kind: "agent", role: "keys", name: "keys", part: STARTER_PARTS.keys, sound: DEFAULT_SOUNDS.keys },
    ] as const;
    for (const s of strips) {
      const musicianId = await ctx.db.insert("musicians", {
        jamId,
        kind: s.kind,
        role: s.role,
        name: s.name,
        muted: false,
        status: "idle",
        turnCause: null,
        turnSeq: 0,
        turnDeadline: 0,
        chatCursor: 0,
        activeDesignId: null,
      });
      const libraryId = s.sound ? lib.get(s.sound)! : null;
      await ctx.db.insert("parts", {
        musicianId,
        jamId,
        version: 1,
        basedOn: 1,
        prev: null,
        prevMuted: null,
        txn,
        undoes: null,
        source: "starter",
        label: s.sound ? STARTER_SOUNDS.find((x) => x.starterKey === s.sound)!.name : "Starter kit",
        lengthBars: s.part.lengthBars,
        notes: [...s.part.notes] as Doc<"parts">["notes"],
        libraryId,
      });
    }
    return jamId;
  },
});

/** Active scene = every strip's newest basedOn and muted match the scene. */
function activeScene(
  jam: Doc<"jams">,
  strips: Array<{ _id: Id<"musicians">; muted: boolean; basedOn: number }>,
): "A" | "B" | null {
  for (const name of ["A", "B"] as const) {
    const scene = jam.scenes[name];
    if (scene && strips.every((m) => scene[m._id]?.basedOn === m.basedOn && scene[m._id]?.muted === m.muted)) {
      return name;
    }
  }
  return null;
}

export const state = query({
  args: { slug: v.string() },
  returns: v.union(v.null(), vState),
  handler: async (ctx, { slug }) => {
    const jam = await jamBySlug(ctx, slug);
    if (!jam) return null;
    const musicians = await musiciansOf(ctx, jam._id);
    const strips = await Promise.all(
      musicians.map(async (m) => {
        const part = await newestPart(ctx, m._id);
        const lib = part.libraryId ? await ctx.db.get(part.libraryId) : null;
        const design = m.activeDesignId ? await ctx.db.get(m.activeDesignId) : null;
        const attempts = design
          ? await ctx.db
              .query("attempts")
              .withIndex("by_design_iteration", (q) => q.eq("designId", design._id))
              .take(20)
          : [];
        return {
          _id: m._id,
          kind: m.kind,
          role: m.role,
          name: m.name,
          muted: m.muted,
          status: m.status,
          turnCause: m.turnCause,
          turnDeadline: m.turnDeadline,
          activeDesignId: m.activeDesignId,
          part: {
            version: part.version,
            basedOn: part.basedOn,
            source: part.source,
            label: part.label,
            lengthBars: part.lengthBars,
            notes: part.notes,
            libraryId: part.libraryId,
            sound: lib ? { name: lib.name, preset: lib.preset } : null,
          },
          design: design
            ? {
                _id: design._id,
                status: design.status,
                origin: design.origin,
                iteration: design.iteration,
                pendingPresetId: design.pendingPresetId,
                renderOwnerClientId: design.renderOwnerClientId,
                renderLeaseUntil: design.renderLeaseUntil,
                renderAttemptNo: design.renderAttemptNo,
                renderSpec: design.renderSpec,
                attempts: attempts.map((a) => ({
                  presetId: a.presetId,
                  iteration: a.iteration,
                  preset: a.preset,
                  rationale: a.rationale,
                  distance: a.distance,
                  isFinal: a.isFinal,
                })),
              }
            : null,
        };
      }),
    );
    return {
      jam: {
        _id: jam._id,
        slug: jam.slug,
        phase: jam.phase,
        reactive: jam.reactive,
        bpm: jam.bpm,
        keyPc: jam.keyPc,
        scale: jam.scale,
        bars: jam.bars,
        progression: jam.progression,
        scenesSaved: { A: jam.scenes.A !== null, B: jam.scenes.B !== null },
        activeScene: activeScene(jam, strips.map((s) => ({ _id: s._id, muted: s.muted, basedOn: s.part.basedOn }))),
      },
      musicians: strips,
    };
  },
});

/** The band chat, newest 200 rows. */
export const chat = query({
  args: { jamId: v.id("jams") },
  returns: v.array(vChatRow),
  handler: async (ctx, { jamId }) => {
    const rows = await ctx.db
      .query("chat")
      .withIndex("by_jam_seq", (q) => q.eq("jamId", jamId))
      .order("desc")
      .take(200);
    return rows.map((r) => ({
      seq: r.seq,
      kind: r.kind,
      fromMusicianId: r.fromMusicianId,
      to: r.to,
      reactor: r.reactor,
      replyToSeq: r.replyToSeq,
      text: r.text,
      octave: r.octave,
    }));
  },
});

async function requireJam(ctx: MutationCtx, jamId: Id<"jams">): Promise<Doc<"jams">> {
  const jam = await ctx.db.get(jamId);
  if (!jam) throw new ConvexError("no such jam");
  return jam;
}

/** Soundcheck → jam. Transport play/stop is client-only; this only flips the phase. */
export const start = mutation({
  args: { jamId: v.id("jams") },
  returns: v.null(),
  handler: async (ctx, { jamId }) => {
    const jam = await requireJam(ctx, jamId);
    if (await anyDesignRunning(ctx, jamId)) throw new ConvexError("A sound is still being designed; the jam starts when it's done.");
    if (jam.phase !== "jam") await ctx.db.patch(jamId, { phase: "jam" });
    return null;
  },
});

export const saveScene = mutation({
  args: { jamId: v.id("jams"), scene: vSceneName },
  returns: v.null(),
  handler: async (ctx, { jamId, scene }) => {
    const jam = await requireJam(ctx, jamId);
    const record: Record<Id<"musicians">, { basedOn: number; muted: boolean }> = {};
    for (const m of await musiciansOf(ctx, jamId)) {
      record[m._id] = { basedOn: (await newestPart(ctx, m._id)).basedOn, muted: m.muted };
    }
    await ctx.db.patch(jamId, { scenes: { ...jam.scenes, [scene]: record } });
    return null;
  },
});

/**
 * Recall a scene: one txn of scene copies for the strips that differ, and
 * their mute restored. Refused while any design runs.
 */
export const recallScene = mutation({
  args: { jamId: v.id("jams"), scene: vSceneName },
  returns: v.null(),
  handler: async (ctx, { jamId, scene }) => {
    const jam = await requireJam(ctx, jamId);
    const saved = jam.scenes[scene];
    if (!saved) throw new ConvexError(`Scene ${scene} hasn't been saved yet.`);
    if (await anyDesignRunning(ctx, jamId)) throw new ConvexError("A sound is still being designed; recall it when that's done.");
    const txn = newTxn();
    for (const m of await musiciansOf(ctx, jamId)) {
      const want = saved[m._id];
      if (!want) continue;
      const current = await newestPart(ctx, m._id);
      if (current.basedOn !== want.basedOn) {
        await discardTurn(ctx, m);
        const target = await contentRow(ctx, m._id, want.basedOn);
        await appendPart(ctx, current, {
          source: "scene",
          basedOn: want.basedOn,
          label: target.label,
          lengthBars: target.lengthBars,
          notes: target.notes,
          libraryId: target.libraryId,
          txn,
          prevMuted: m.muted,
        });
      }
      if (m.muted !== want.muted) await ctx.db.patch(m._id, { muted: want.muted });
    }
    return null;
  },
});

export const setBpm = mutation({
  args: { jamId: v.id("jams"), bpm: v.number() },
  returns: v.null(),
  handler: async (ctx, { jamId, bpm }) => {
    await requireJam(ctx, jamId);
    await ctx.db.patch(jamId, { bpm: clampBpm(bpm) });
    return null;
  },
});

export const setReactive = mutation({
  args: { jamId: v.id("jams"), reactive: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { jamId, reactive }) => {
    await requireJam(ctx, jamId);
    await ctx.db.patch(jamId, { reactive });
    return null;
  },
});
