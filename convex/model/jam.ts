/**
 * Shared reads and writes for the band's direct mutations (plan §4 "Direct
 * producer mutations").
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";

export type Musician = Doc<"musicians">;
export type Part = Doc<"parts">;

export async function jamBySlug(ctx: QueryCtx, slug: string): Promise<Doc<"jams"> | null> {
  return await ctx.db
    .query("jams")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

export async function musiciansOf(ctx: QueryCtx, jamId: Id<"jams">): Promise<Musician[]> {
  return await ctx.db
    .query("musicians")
    .withIndex("by_jam", (q) => q.eq("jamId", jamId))
    .take(4);
}

/** The part that plays: the newest version. */
export async function newestPart(ctx: QueryCtx, musicianId: Id<"musicians">): Promise<Part> {
  const p = await ctx.db
    .query("parts")
    .withIndex("by_musician_version", (q) => q.eq("musicianId", musicianId))
    .order("desc")
    .first();
  if (!p) throw new Error(`musician ${musicianId} has no part`);
  return p;
}

/** The tempo range, shared by create and setBpm. */
export function clampBpm(bpm: number): number {
  return Math.min(240, Math.max(60, Math.round(bpm)));
}

/** One id per mutation, stamped on every row it writes (wave 2 undo). */
export function newTxn(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** "Any design running": read activeDesignId on the jam's four musicians. */
export async function anyDesignRunning(ctx: QueryCtx, jamId: Id<"jams">): Promise<boolean> {
  return (await musiciansOf(ctx, jamId)).some((m) => m.activeDesignId !== null);
}

export function refuseWhileDesigning(m: Musician): void {
  if (m.activeDesignId !== null) {
    throw new ConvexError(`${m.name} is designing a sound; that has to finish first.`);
  }
}

/**
 * Your rollback always wins: stepping, jumping, picking or recalling on a
 * thinking musician discards its turn. Wave 1 bumps turnSeq (the fence), so a
 * late commit is a no-op; wave 2 uses cancelTurn.
 */
export async function discardTurn(ctx: MutationCtx, m: Musician): Promise<void> {
  if (m.status !== "thinking") return;
  await ctx.db.patch(m._id, { status: "idle", turnSeq: m.turnSeq + 1, turnDeadline: 0, turnCause: null });
}

/** Append a part version: the next version, read newest-first, plus one. */
export async function appendPart(
  ctx: MutationCtx,
  current: Part,
  row: Pick<Part, "source" | "label" | "lengthBars" | "notes" | "libraryId"> & {
    basedOn?: number;
    txn: string;
    prevMuted?: boolean | null;
  },
): Promise<Id<"parts">> {
  const version = current.version + 1;
  return await ctx.db.insert("parts", {
    musicianId: current.musicianId,
    jamId: current.jamId,
    version,
    basedOn: row.basedOn ?? version,
    prev: current.basedOn,
    prevMuted: row.prevMuted ?? null,
    txn: row.txn,
    undoes: null,
    source: row.source,
    label: row.label,
    lengthBars: row.lengthBars,
    notes: row.notes,
    libraryId: row.libraryId,
  });
}

/** The content row a basedOn names (its own version). */
export async function contentRow(ctx: QueryCtx, musicianId: Id<"musicians">, basedOn: number): Promise<Part> {
  const p = await ctx.db
    .query("parts")
    .withIndex("by_musician_version", (q) => q.eq("musicianId", musicianId).eq("version", basedOn))
    .unique();
  if (!p) throw new Error(`no version ${basedOn} for ${musicianId}`);
  return p;
}

const CONTENT_SOURCES = ["starter", "agent", "pick", "design"] as const;

/**
 * What planHistory needs: every content version (the pips; few, since copies
 * are excluded) plus the newest row, and for a jump the row it names.
 * Reading by source keeps this bounded however many ←/→ copies pile up.
 */
export async function historyRows(ctx: QueryCtx, musicianId: Id<"musicians">, jumpVersion?: number): Promise<Part[]> {
  const content = (
    await Promise.all(
      CONTENT_SOURCES.map((source) =>
        ctx.db
          .query("parts")
          .withIndex("by_musician_source", (q) => q.eq("musicianId", musicianId).eq("source", source))
          .order("desc")
          .take(200),
      ),
    )
  ).flat();
  const rows = new Map(content.map((r) => [r.version, r]));
  const newest = await newestPart(ctx, musicianId);
  rows.set(newest.version, newest);
  if (jumpVersion !== undefined && !rows.has(jumpVersion)) {
    const j = await ctx.db
      .query("parts")
      .withIndex("by_musician_version", (q) => q.eq("musicianId", musicianId).eq("version", jumpVersion))
      .unique();
    if (j) rows.set(j.version, j);
  }
  return [...rows.values()].sort((a, b) => a.version - b.version);
}
