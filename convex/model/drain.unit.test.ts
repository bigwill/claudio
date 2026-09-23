/**
 * planDrain: the one inbox rule (plan §4 drainInbox). Pure; the mutation that
 * calls it supplies the rows after the musician's cursor, in seq order.
 */
import { describe, expect, test } from "vitest";

import { planDrain, type DrainInput, type DrainRow } from "./drain";

const M = "bass";
const row = (seq: number, over: Partial<DrainRow> = {}): DrainRow => ({
  seq,
  kind: "producer",
  fromMusicianId: null,
  to: [M],
  reactor: null,
  ...over,
});
const base = (rows: DrainRow[], over: Partial<DrainInput> = {}): DrainInput => ({
  musician: { id: M, kind: "agent", status: "idle", activeDesignId: null, chatCursor: 0 },
  rows,
  lastProducerSeq: 0,
  reactionBudget: 0,
  reactive: true,
  ...over,
});

describe("planDrain", () => {
  test("a producer note to this musician starts a turn with every relevant row, cursor at the last scanned", () => {
    const rows = [row(1, { kind: "system", to: [] }), row(2), row(3, { kind: "musician", fromMusicianId: "keys", to: ["drums"] })];
    const p = planDrain(base(rows, { lastProducerSeq: 2 }));
    expect(p).toEqual({ action: "turn", rows: [1, 2], cursor: 3, cause: "producer", spend: 0 });
  });

  test("the human musician never drains", () => {
    const p = planDrain(base([row(1)], { musician: { id: M, kind: "human", status: "idle", activeDesignId: null, chatCursor: 0 } }));
    expect(p).toEqual({ action: "none" });
  });

  test("a thinking or designing musician holds everything (cursor unmoved)", () => {
    expect(planDrain(base([row(1)], { musician: { id: M, kind: "agent", status: "thinking", activeDesignId: null, chatCursor: 0 } }))).toEqual({ action: "hold" });
    expect(planDrain(base([row(1)], { musician: { id: M, kind: "agent", status: "idle", activeDesignId: "d1", chatCursor: 0 } }))).toEqual({ action: "hold" });
  });

  test("its own rows are never relevant", () => {
    const rows = [row(1, { kind: "musician", fromMusicianId: M, to: [] })];
    expect(planDrain(base(rows))).toEqual({ action: "advance", cursor: 1 });
  });

  test("a nudge triggers only its reactor, only if newer than the last producer note, with budget, when reactive", () => {
    const nudge = row(5, { kind: "nudge", to: [], reactor: M, fromMusicianId: "drums" });
    expect(planDrain(base([nudge], { lastProducerSeq: 4, reactionBudget: 1 }))).toEqual({
      action: "turn",
      rows: [5],
      cursor: 5,
      cause: "nudge",
      spend: 1,
    });
    // Not the reactor, stale, no budget, or reacts off: context only; the cursor waits just before it.
    const notMine = row(5, { kind: "nudge", to: [], reactor: "keys", fromMusicianId: "drums" });
    expect(planDrain(base([notMine], { lastProducerSeq: 4, reactionBudget: 1 }))).toEqual({ action: "advance", cursor: 4 });
    expect(planDrain(base([nudge], { lastProducerSeq: 6, reactionBudget: 1 }))).toEqual({ action: "advance", cursor: 4 });
    expect(planDrain(base([nudge], { lastProducerSeq: 4, reactionBudget: 0 }))).toEqual({ action: "advance", cursor: 4 });
    expect(planDrain(base([nudge], { lastProducerSeq: 4, reactionBudget: 1, reactive: false }))).toEqual({ action: "advance", cursor: 4 });
  });

  test("a producer row in the batch makes the cause producer and spends nothing, even with a nudge alongside", () => {
    const rows = [row(3, { kind: "nudge", to: [], reactor: M, fromMusicianId: "drums" }), row(4)];
    expect(planDrain(base(rows, { lastProducerSeq: 4, reactionBudget: 1 }))).toMatchObject({ action: "turn", cause: "producer", spend: 0 });
  });

  test("with no trigger, the cursor skips irrelevant rows but stops before the first unread context row", () => {
    const rows = [
      row(1, { to: ["keys"] }), // someone else's note: skip
      row(2, { kind: "system", to: [M] }), // context for me: wait before it
      row(3, { to: ["keys"] }),
    ];
    expect(planDrain(base(rows))).toEqual({ action: "advance", cursor: 1 });
  });

  test("nothing new: no change", () => {
    expect(planDrain(base([]))).toEqual({ action: "none" });
  });
});
