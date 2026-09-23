/**
 * planHistory: where ←/→, Shift+←/→ and a click on a pip take a strip (plan §1).
 * Pips are content versions (starter/agent/pick/design); copies (history/scene/
 * undo) restate a content version's basedOn and are never pips.
 */
import { describe, expect, test } from "vitest";

import { pipLabels, planHistory, type PartRow } from "./history";

const content = (version: number, source: PartRow["source"] = "agent"): PartRow => ({ version, basedOn: version, source });
const copy = (version: number, basedOn: number, source: PartRow["source"] = "history"): PartRow => ({ version, basedOn, source });

/** Apply a plan the way the mutation would: append a history copy. */
function apply(rows: PartRow[], target: number | null): PartRow[] {
  if (target === null) return rows;
  return [...rows, copy(rows.length + 1, target)];
}
const current = (rows: PartRow[]) => rows[rows.length - 1].basedOn;

describe("planHistory", () => {
  test("the plan's canonical example: v1–v4, ← ← → v2, → → v3, a prompt adds v5, ← → v4", () => {
    let rows = [content(1, "starter"), content(2), content(3), content(4)];
    rows = apply(rows, planHistory(rows, { kind: "step", dir: -1 }));
    rows = apply(rows, planHistory(rows, { kind: "step", dir: -1 }));
    expect(current(rows)).toBe(2);
    rows = apply(rows, planHistory(rows, { kind: "step", dir: 1 }));
    expect(current(rows)).toBe(3);
    rows = [...rows, content(rows.length + 1)]; // a new prompt: the next content version
    expect(pipLabels(rows).at(-1)).toEqual({ basedOn: rows.length, label: "v5" });
    rows = apply(rows, planHistory(rows, { kind: "step", dir: -1 }));
    expect(current(rows)).toBe(4);
  });

  test("nothing is written at either end", () => {
    const rows = [content(1, "starter"), content(2)];
    expect(planHistory(rows, { kind: "step", dir: 1 })).toBeNull();
    const back = apply(rows, planHistory(rows, { kind: "step", dir: -1 }));
    expect(planHistory(back, { kind: "step", dir: -1 })).toBeNull();
  });

  test("Shift+←/→ jump to the oldest and newest pip; no row if already there", () => {
    const rows = [content(1, "starter"), content(2), content(3)];
    expect(planHistory(rows, { kind: "oldest" })).toBe(1);
    expect(planHistory(rows, { kind: "newest" })).toBeNull();
  });

  test("a jump to the current version writes nothing; a jump to a copy resolves to its basedOn", () => {
    let rows = [content(1, "starter"), content(2), content(3)];
    expect(planHistory(rows, { kind: "jump", version: 3 })).toBeNull();
    rows = apply(rows, 1); // row 4 is a copy of v1
    expect(planHistory(rows, { kind: "jump", version: 4 })).toBeNull(); // resolves to 1, already current
    expect(planHistory(rows, { kind: "jump", version: 2 })).toBe(2);
  });

  test("an unknown version writes nothing", () => {
    expect(planHistory([content(1, "starter")], { kind: "jump", version: 9 })).toBeNull();
  });

  test("steps move between pips even when the current row is a scene or undo copy", () => {
    const rows = [content(1, "starter"), content(2), content(3), copy(4, 2, "scene")];
    expect(planHistory(rows, { kind: "step", dir: 1 })).toBe(3);
    expect(planHistory(rows, { kind: "step", dir: -1 })).toBe(1);
  });
});

describe("pipLabels", () => {
  test("labels content versions v1…vN in order; copies are not pips", () => {
    const rows = [content(1, "starter"), content(2), copy(3, 1), content(4, "pick"), copy(5, 2, "scene"), content(6, "design")];
    expect(pipLabels(rows)).toEqual([
      { basedOn: 1, label: "v1" },
      { basedOn: 2, label: "v2" },
      { basedOn: 4, label: "v3" },
      { basedOn: 6, label: "v4" },
    ]);
  });
});
