/**
 * planDrain: the one inbox rule (plan §4 drainInbox). Pure.
 *
 * Given the chat rows after a musician's cursor, decide whether they start a
 * turn, and where the cursor ends up. `drainInbox` (slice 5) wraps this in the
 * mutation that appends the user turn, moves the cursor and begins the turn.
 */

export interface DrainRow {
  seq: number;
  kind: "producer" | "musician" | "system" | "nudge";
  fromMusicianId: string | null;
  /** Musician ids; empty means every agent. */
  to: readonly string[];
  /** The one musician a nudge may trigger. */
  reactor: string | null;
}

export interface DrainInput {
  musician: {
    id: string;
    kind: "agent" | "human";
    status: "idle" | "thinking";
    activeDesignId: string | null;
    chatCursor: number;
  };
  /** Rows with seq > chatCursor, ascending. */
  rows: readonly DrainRow[];
  lastProducerSeq: number;
  reactionBudget: number;
  reactive: boolean;
}

export type DrainPlan =
  | { action: "none" }
  /** Thinking or designing: notes wait ("queued until the sound is done"). */
  | { action: "hold" }
  | { action: "advance"; cursor: number }
  | { action: "turn"; rows: number[]; cursor: number; cause: "producer" | "nudge"; spend: 0 | 1 };

export function planDrain(input: DrainInput): DrainPlan {
  const { musician: m, rows } = input;
  if (m.kind === "human") return { action: "none" };
  if (m.status === "thinking" || m.activeDesignId !== null) return { action: "hold" };
  if (rows.length === 0) return { action: "none" };

  const relevant = rows.filter((r) => r.fromMusicianId !== m.id && (r.to.length === 0 || r.to.includes(m.id)));
  const producer = relevant.some((r) => r.kind === "producer");
  const nudge = relevant.some(
    (r) =>
      r.kind === "nudge" &&
      r.reactor === m.id &&
      r.seq > input.lastProducerSeq &&
      input.reactionBudget > 0 &&
      input.reactive,
  );
  const last = rows[rows.length - 1].seq;

  if (producer || nudge) {
    return {
      action: "turn",
      rows: relevant.map((r) => r.seq),
      cursor: last,
      cause: producer ? "producer" : "nudge",
      spend: producer ? 0 : 1,
    };
  }
  // No trigger: skip what isn't mine, but wait just before the first unread
  // context row (nudge, system, a bandmate's line) so the next turn sees it.
  return { action: "advance", cursor: relevant.length ? relevant[0].seq - 1 : last };
}
