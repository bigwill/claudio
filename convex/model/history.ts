/**
 * planHistory: where a history move takes a strip (plan §1, "Arrows move along
 * a strip's rail"). Pure.
 *
 * Every part row has a sequential `version`. Content versions (starter, agent,
 * pick, design) are the rail's pips, and their `basedOn` is their own version.
 * Copies (history, scene, undo) restate a content version's `basedOn`. The
 * newest row plays, so "where the strip is" is the newest row's basedOn.
 *
 * Pips are labelled by their order among content versions (v1…vN), not by row
 * version, so copies never leave gaps in the labels.
 */

export type PartSource = "starter" | "agent" | "pick" | "design" | "history" | "scene" | "undo";

export interface PartRow {
  version: number;
  basedOn: number;
  source: PartSource;
}

export type HistoryMove =
  | { kind: "step"; dir: -1 | 1 }
  | { kind: "oldest" }
  | { kind: "newest" }
  | { kind: "jump"; version: number };

const CONTENT: ReadonlySet<PartSource> = new Set(["starter", "agent", "pick", "design"]);

export function isContent(source: PartSource): boolean {
  return CONTENT.has(source);
}

/** The rail: content versions in time order, with their display labels. */
export function pipLabels(rows: readonly PartRow[]): Array<{ basedOn: number; label: string }> {
  return rows
    .filter((r) => isContent(r.source))
    .sort((a, b) => a.version - b.version)
    .map((r, i) => ({ basedOn: r.basedOn, label: `v${i + 1}` }));
}

/**
 * The basedOn to restate as a new history copy, or null to write nothing (at
 * either end, a jump to where the strip already is, or an unknown version).
 * `rows` must include the newest row.
 */
export function planHistory(rows: readonly PartRow[], move: HistoryMove): number | null {
  if (rows.length === 0) return null;
  const newest = rows.reduce((a, b) => (b.version > a.version ? b : a));
  const current = newest.basedOn;
  const pips = pipLabels(rows).map((p) => p.basedOn);
  let target: number | undefined;
  switch (move.kind) {
    case "step": {
      const i = pips.indexOf(current);
      if (i < 0) return null;
      target = pips[i + move.dir];
      break;
    }
    case "oldest":
      target = pips[0];
      break;
    case "newest":
      target = pips[pips.length - 1];
      break;
    case "jump":
      target = rows.find((r) => r.version === move.version)?.basedOn;
      break;
  }
  return target === undefined || target === current ? null : target;
}
