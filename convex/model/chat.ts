/**
 * postChat: the band chat's only writer (plan §4).
 *
 * The seq comes from jamCounters (read and written in this transaction), so
 * chat order is commit order and a musician's cursor can never skip a row.
 * Draining each target's inbox after the insert is slice 5 (drainInbox).
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export interface ChatRowInput {
  kind: Doc<"chat">["kind"];
  text: string;
  fromMusicianId?: Id<"musicians"> | null;
  to?: Id<"musicians">[];
  reactor?: Id<"musicians"> | null;
  replyToSeq?: number | null;
  octave?: number | null;
}

export async function countersFor(ctx: MutationCtx, jamId: Id<"jams">): Promise<Doc<"jamCounters">> {
  const c = await ctx.db
    .query("jamCounters")
    .withIndex("by_jam", (q) => q.eq("jamId", jamId))
    .unique();
  if (!c) throw new Error(`jam ${jamId} has no counters`);
  return c;
}

/** Insert one chat row; returns its seq. */
export async function postChat(ctx: MutationCtx, jamId: Id<"jams">, row: ChatRowInput): Promise<number> {
  const counters = await countersFor(ctx, jamId);
  const seq = counters.chatSeq + 1;
  const patch: Partial<Doc<"jamCounters">> = { chatSeq: seq };
  if (row.kind === "producer") patch.lastProducerSeq = seq;
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
  return seq;
}
