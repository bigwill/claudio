/**
 * postChat: the band chat's only writer (plan §4).
 *
 * The seq comes from jamCounters (read and written in this transaction), so
 * chat order is commit order and a musician's cursor can never skip a row.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { drainInbox } from "./inbox";

export interface ChatRowInput {
  kind: Doc<"chat">["kind"];
  text: string;
  fromMusicianId?: Id<"musicians"> | null;
  to?: Id<"musicians">[];
  reactor?: Id<"musicians"> | null;
  replyToSeq?: number | null;
  octave?: number | null;
  /** Producer notes grant the reaction budget in the same counters write. */
  reactionBudget?: number;
}

export async function countersFor(ctx: MutationCtx, jamId: Id<"jams">): Promise<Doc<"jamCounters">> {
  const c = await ctx.db
    .query("jamCounters")
    .withIndex("by_jam", (q) => q.eq("jamId", jamId))
    .unique();
  if (!c) throw new Error(`jam ${jamId} has no counters`);
  return c;
}

/**
 * Insert one chat row, then drain each target's inbox (plan §4): the row's
 * `to[]`, or every agent when it's empty, never its own author. A producer
 * note to an idle musician starts its turn in this same mutation.
 */
export async function postChat(ctx: MutationCtx, jamId: Id<"jams">, row: ChatRowInput): Promise<number> {
  const counters = await countersFor(ctx, jamId);
  const seq = counters.chatSeq + 1;
  const patch: Partial<Doc<"jamCounters">> = { chatSeq: seq };
  if (row.kind === "producer") patch.lastProducerSeq = seq;
  if (row.reactionBudget !== undefined) patch.reactionBudget = row.reactionBudget;
  await ctx.db.patch(counters._id, patch);
  await ctx.db.insert("chat", {
    jamId,
    seq,
    kind: row.kind,
    fromMusicianId: row.fromMusicianId ?? null,
    to: (row.to ?? []).slice(0, 3),
    reactor: row.reactor ?? null,
    replyToSeq: row.replyToSeq ?? null,
    text: row.text.slice(0, 2000),
    octave: row.octave ?? null,
  });
  const band = await ctx.db
    .query("musicians")
    .withIndex("by_jam", (q) => q.eq("jamId", jamId))
    .take(4);
  const targets = band.filter(
    (m) => m.kind === "agent" && m._id !== row.fromMusicianId && (!row.to?.length || row.to.includes(m._id)),
  );
  for (const m of targets) await drainInbox(ctx, m._id);
  return seq;
}
