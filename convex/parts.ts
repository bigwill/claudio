/**
 * A strip's versions: library picks, history moves and the rail (plan §1).
 * History moves and picks are refused while the musician is designing, and
 * discard a thinking musician's turn: your rollback always wins.
 */

import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { vPartSource } from "./schema";
import { planHistory, pipLabels } from "./model/history";
import { appendPart, contentRow, discardTurn, historyRows, newestPart, newTxn, refuseWhileDesigning } from "./model/jam";

const vMove = v.union(
  v.object({ kind: v.literal("step"), dir: v.union(v.literal(-1), v.literal(1)) }),
  v.object({ kind: v.literal("oldest") }),
  v.object({ kind: v.literal("newest") }),
  v.object({ kind: v.literal("jump"), version: v.number() }),
);

export const history = mutation({
  args: { musicianId: v.id("musicians"), move: vMove },
  returns: v.object({ moved: v.boolean() }),
  handler: async (ctx, { musicianId, move }) => {
    const m = await ctx.db.get(musicianId);
    if (!m) throw new ConvexError("no such musician");
    refuseWhileDesigning(m);
    const rows = await historyRows(ctx, musicianId, move.kind === "jump" ? move.version : undefined);
    const target = planHistory(rows, move);
    if (target === null) return { moved: false };
    await discardTurn(ctx, m);
    const current = rows[rows.length - 1];
    const content = await contentRow(ctx, musicianId, target);
    await appendPart(ctx, current, {
      source: "history",
      basedOn: target,
      label: content.label,
      lengthBars: content.lengthBars,
      notes: content.notes,
      libraryId: content.libraryId,
      txn: newTxn(),
    });
    return { moved: true };
  },
});

/** Pick a library sound: a new content version with the same notes. */
export const pick = mutation({
  args: { musicianId: v.id("musicians"), libraryId: v.id("library") },
  returns: v.null(),
  handler: async (ctx, { musicianId, libraryId }) => {
    const m = await ctx.db.get(musicianId);
    if (!m) throw new ConvexError("no such musician");
    if (m.role === "drums") throw new ConvexError("Drums play the kit; there's no sound to pick.");
    refuseWhileDesigning(m);
    const lib = await ctx.db.get(libraryId);
    if (!lib) throw new ConvexError("no such sound");
    if (m.role !== "producer" && lib.role !== m.role) throw new ConvexError(`${lib.name} is a ${lib.role} sound.`);
    await discardTurn(ctx, m);
    const current = await newestPart(ctx, musicianId);
    if (current.libraryId === libraryId) return null;
    await appendPart(ctx, current, {
      source: "pick",
      label: lib.name,
      lengthBars: current.lengthBars,
      notes: current.notes,
      libraryId,
      txn: newTxn(),
    });
    return null;
  },
});

/** The history rail: content versions, labelled v1…vN, with their captions. */
export const rail = query({
  args: { musicianId: v.id("musicians") },
  returns: v.array(v.object({ basedOn: v.number(), label: v.string(), caption: v.string(), source: vPartSource })),
  handler: async (ctx, { musicianId }) => {
    const rows = await historyRows(ctx, musicianId);
    const byVersion = new Map(rows.map((r) => [r.version, r]));
    return pipLabels(rows).map((p) => {
      const row = byVersion.get(p.basedOn)!;
      return { basedOn: p.basedOn, label: p.label, caption: row.label, source: row.source };
    });
  },
});
