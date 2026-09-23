/**
 * 1b replay experiment. COSTS MONEY; Will's go-ahead only.
 *   node scripts/replay-1b.mjs --yes [--model=claude-opus-5-5] [--samples=5] [--spike=<design json>] [--before=3]
 * Resends one failing design turn under conditions A (as the port sends it),
 * B (without system rule 10), C (rationale first, name last) and reports the
 * placeholder rate per condition to docs/spikes/1b-replay-<model>.json.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { convex, withRealModel } from "./devstack.mjs";

if (!process.argv.includes("--yes")) {
  console.error("[replay-1b] spends real API money. Re-run with --yes once approved.");
  process.exit(2);
}
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const model = arg("model", "claude-opus-5-5");
const samples = Number(arg("samples", 5));
const spike = arg("spike", `docs/spikes/1b-design-${model}.json`);
const beforeSeq = Number(arg("before", 3));
const slug = JSON.parse(readFileSync(spike, "utf8")).slug;
const PRICE = { "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25] }[model] ?? [5, 25];

const out = { model, slug, beforeSeq, samples, at: new Date().toISOString(), conditions: {} };
let cost = 0;
await withRealModel("replay-1b", async () => {
  for (const condition of ["A", "B", "C"]) {
    const rows = JSON.parse(JSON.parse(convex("run", "spikes:replayTurn", JSON.stringify({ slug, beforeSeq, condition, samples, model }))));
    for (const r of rows) if (r.usage) cost += (r.usage.in * PRICE[0] + r.usage.out * PRICE[1]) / 1e6;
    const bad = rows.filter((r) => r.placeholder || r.error).length;
    out.conditions[condition] = { placeholderRate: `${bad}/${rows.length}`, rows };
    console.log(`\n[${condition}] placeholders ${bad}/${rows.length}`);
    for (const r of rows) console.log(r.error ? `  ERROR ${r.error}` : `  ${r.placeholder ? "✗" : "✓"} ${r.tool} name=${JSON.stringify(r.name)} harm=${r.harmonicity} mi=${r.modulationIndex} rationale=${JSON.stringify(r.rationale.slice(0, 60))} ${r.ms}ms`);
  }
});
out.costUsd = Number(cost.toFixed(3));
writeFileSync(`docs/spikes/1b-replay-${model}.json`, JSON.stringify(out, null, 2) + "\n");
console.log(`\ncost ≈ $${out.costUsd}`);
