/**
 * A musician's inbox (plan §4 drainInbox): the one rule for when chat becomes
 * a band turn. planDrain decides; this applies it in the caller's mutation —
 * append one user turn (heal blocks, then the snapshot, then every relevant
 * row), move the cursor, set turnCause, spend the budget, and begin the turn.
 */

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { summarizePattern, type Pattern, type Scale } from "../../src/shared/pattern";
import { planDrain, type DrainPlan } from "./drain";
import { pipLabels } from "./history";
import { historyRows } from "./jam";
import { LLM } from "./llmConfig";
import { appendMessage, healBlocks, tailMessage } from "./messages";
import { buildSnapshot } from "./snapshot";

export async function inboxPlan(ctx: QueryCtx, musicianId: Id<"musicians">): Promise<DrainPlan> {
  const m = await ctx.db.get(musicianId);
  if (!m) return { action: "none" };
  const counters = await ctx.db
    .query("jamCounters")
    .withIndex("by_jam", (q) => q.eq("jamId", m.jamId))
    .unique();
  const jam = await ctx.db.get(m.jamId);
  const rows = await ctx.db
    .query("chat")
    .withIndex("by_jam_seq", (q) => q.eq("jamId", m.jamId).gt("seq", m.chatCursor))
    .take(50);
  return planDrain({
    musician: { id: m._id, kind: m.kind, status: m.status, activeDesignId: m.activeDesignId, chatCursor: m.chatCursor },
    rows: rows.map((r) => ({ seq: r.seq, kind: r.kind, fromMusicianId: r.fromMusicianId, to: r.to, reactor: r.reactor })),
    lastProducerSeq: counters?.lastProducerSeq ?? 0,
    reactionBudget: counters?.reactionBudget ?? 0,
    reactive: jam?.reactive ?? true,
  });
}

export async function drainInbox(ctx: MutationCtx, musicianId: Id<"musicians">): Promise<DrainPlan> {
  const plan = await inboxPlan(ctx, musicianId);
  if (plan.action === "advance") await ctx.db.patch(musicianId, { chatCursor: plan.cursor });
  if (plan.action !== "turn") return plan;

  const m = (await ctx.db.get(musicianId))!;
  const rows = await ctx.db
    .query("chat")
    .withIndex("by_jam_seq", (q) => q.eq("jamId", m.jamId).gt("seq", m.chatCursor).lte("seq", plan.cursor))
    .take(50);
  const names = new Map((await bandOf(ctx, m.jamId)).map((b) => [b._id as string, b.role === "producer" ? "producer" : b.name]));
  const heard = rows.filter((r) => plan.rows.includes(r.seq)).map((r) => formatRow(r, names));

  await appendMessage(ctx, m._id, {
    role: "user",
    content: [...healBlocks(await tailMessage(ctx, m._id)), { type: "text", text: `${await snapshotFor(ctx, m)}\n\n${heard.join("\n")}` }],
  });
  if (plan.spend) {
    const counters = await ctx.db
      .query("jamCounters")
      .withIndex("by_jam", (q) => q.eq("jamId", m.jamId))
      .unique();
    if (counters) await ctx.db.patch(counters._id, { reactionBudget: Math.max(0, counters.reactionBudget - 1) });
  }
  const turnSeq = m.turnSeq + 1;
  await ctx.db.patch(m._id, {
    chatCursor: plan.cursor,
    turnCause: plan.cause,
    status: "thinking",
    turnSeq,
    turnDeadline: Date.now() + LLM.band.leaseMs,
  });
  await ctx.scheduler.runAfter(0, internal.band.runBandTurn, { musicianId: m._id, turnSeq });
  return plan;
}

function formatRow(r: Doc<"chat">, names: Map<string, string>): string {
  const to = r.to.length ? r.to.map((id) => `@${names.get(id) ?? "?"}`).join(" ") : "@all";
  if (r.kind === "producer") return `[producer → ${to}] ${r.text}`;
  if (r.kind === "musician") return `[${names.get(r.fromMusicianId ?? "") ?? "bandmate"}] ${r.text}`;
  if (r.kind === "nudge") return `[band] ${r.text}`;
  return `[system] ${r.text}`;
}

async function bandOf(ctx: QueryCtx, jamId: Id<"jams">): Promise<Doc<"musicians">[]> {
  return await ctx.db
    .query("musicians")
    .withIndex("by_jam", (q) => q.eq("jamId", jamId))
    .take(4);
}

async function newest(ctx: QueryCtx, musicianId: Id<"musicians">): Promise<Doc<"parts">> {
  return (await ctx.db
    .query("parts")
    .withIndex("by_musician_version", (q) => q.eq("musicianId", musicianId))
    .order("desc")
    .first())!;
}

/** Gather plan §5's snapshot for one musician. */
async function snapshotFor(ctx: QueryCtx, m: Doc<"musicians">): Promise<string> {
  const jam = (await ctx.db.get(m.jamId))!;
  const band = await bandOf(ctx, m.jamId);
  const soundOf = async (p: Doc<"parts">) => (p.libraryId ? await ctx.db.get(p.libraryId) : null);
  const summary = (role: string, p: Doc<"parts">) =>
    role === "producer" ? "" : summarizePattern(role as "drums" | "bass" | "keys", { lengthBars: p.lengthBars, notes: p.notes } as Pattern);

  const mine = await newest(ctx, m._id);
  const mySound = await soundOf(mine);
  const contentRows = await historyRows(ctx, m._id);
  const pips = pipLabels(contentRows);
  const labelOf = (basedOn: number | null) => pips.find((p) => p.basedOn === basedOn)?.label ?? "v?";
  const captionOf = (basedOn: number | null) => contentRows.find((r) => r.version === basedOn)?.label ?? "";

  const others = [];
  let producer: { soundName: string | null; octave: number | null } = { soundName: null, octave: null };
  for (const b of band) {
    if (b._id === m._id) continue;
    const p = await newest(ctx, b._id);
    const lib = await soundOf(p);
    if (b.role === "producer") {
      producer = { soundName: lib?.name ?? null, octave: null };
      continue;
    }
    others.push({ role: b.role, summary: summary(b.role, p), soundName: b.role === "drums" ? "Kit" : (lib?.name ?? null), muted: b.muted });
  }
  const recent = await ctx.db
    .query("chat")
    .withIndex("by_jam_seq", (q) => q.eq("jamId", m.jamId))
    .order("desc")
    .take(50);
  producer.octave = recent.find((r) => r.kind === "producer")?.octave ?? null;

  const library: string[] = [];
  if (m.role === "bass" || m.role === "keys") {
    const role = m.role;
    const starters = await ctx.db
      .query("library")
      .withIndex("by_role_jam", (q) => q.eq("role", role).eq("fromJamId", null))
      .take(8);
    const ours = await ctx.db
      .query("library")
      .withIndex("by_role_jam", (q) => q.eq("role", role).eq("fromJamId", m.jamId))
      .order("desc")
      .take(8);
    for (const l of [...ours, ...starters]) if (!library.includes(l.name) && library.length < 8) library.push(l.name);
  }

  const rollback =
    mine.source === "history" || mine.source === "undo"
      ? { fromLabel: labelOf(mine.prev), fromCaption: captionOf(mine.prev), toLabel: labelOf(mine.basedOn) }
      : null;
  const scene =
    mine.source === "scene" ? ((["A", "B"] as const).find((n) => jam.scenes[n]?.[m._id]?.basedOn === mine.basedOn) ?? "A") : null;

  return buildSnapshot({
    jam: { bpm: jam.bpm, keyPc: jam.keyPc, scale: jam.scale as Scale, bars: jam.bars, progression: jam.progression },
    me: {
      role: m.role,
      partSummary: summary(m.role, mine),
      soundName: m.role === "drums" ? "Kit" : (mySound?.name ?? null),
      preset: mySound?.preset ?? null,
      versionLabel: labelOf(mine.basedOn),
    },
    others,
    producer,
    library,
    rollback,
    scene,
  });
}

/** The producer note a turn answers: the newest one to this musician (or everyone) it has read. */
export async function answeredNote(ctx: QueryCtx, m: Doc<"musicians">): Promise<number | null> {
  const rows = await ctx.db
    .query("chat")
    .withIndex("by_jam_seq", (q) => q.eq("jamId", m.jamId).lte("seq", m.chatCursor))
    .order("desc")
    .take(50);
  const note = rows.find((r) => r.kind === "producer" && (r.to.length === 0 || r.to.includes(m._id)));
  return note?.seq ?? null;
}
