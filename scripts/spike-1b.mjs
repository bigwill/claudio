/**
 * Slice 1b: real-model spikes. COSTS MONEY; Will's go-ahead only.
 *
 *   node scripts/spike-1b.mjs --yes [--band] [--design] [--design-model=<id>]   (default: both, claude-opus-5-5)
 *
 * Band: Sonnet 5 answers producer notes with set_pattern (spikes:bandTurn).
 *   Records latency (bar: p50 ≤ 10s) and writes the parts to
 *   docs/spikes/1b-band.json, which the ?spike=1 page offers as variants.
 * Design: Opus 5.5 designs from electric_piano_jd800_soft_ep.wav through
 *   today's loop (DESIGN_MODEL=claude-opus-5-5), driven in a real browser.
 *   Records wall time and no-tool turns to docs/spikes/1b-design.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { runDesign } from "./design-run.mjs";
import { convex, withRealModel } from "./devstack.mjs";

if (!process.argv.includes("--yes")) {
  console.error("[spike-1b] spends real API money. Re-run with --yes once approved.");
  process.exit(2);
}
const only = ["--band", "--design"].filter((f) => process.argv.includes(f));
const doBand = only.length === 0 || only.includes("--band");
const doDesign = only.length === 0 || only.includes("--design");
const designModel = process.argv.find((a) => a.startsWith("--design-model="))?.split("=")[1] ?? "claude-opus-5-5";
mkdirSync("docs/spikes", { recursive: true });

// The spike page's "a" parts, as the agents' snapshot will render them (§5).
const SNAPSHOT = `[band snapshot]
Tempo 96 bpm · D minor · 4-bar loop · chords one per bar: Dm, Bb, F, C (roots are scale degrees 0, 5, 2, 6)
drums: 1 bar · kick 0X,8,10 · snare 4,12 · hat 0,2,4,6,8,10,12 · openhat 14
bass: 1 bar · 0:0/3X 6:0/2 8:0/3 14:4/2   (Rubber Bass)
keys: 1 bar · 0:0/3 0:2/3 0:4/3 6:0/2 6:2/2 6:4/2 12:0/2 12:2/2 12:4/2   (Spike EP)
The producer is playing along live on Soft Pad, around octave 4 (D4 up); leave room.`;

const NOTES = [
  ["bass", "busier, eighth notes"],
  ["bass", "lay back, half-time feel, leave space"],
  ["bass", "more syncopation, push into beat 3"],
  ["keys", "sparser, just stabs on the offbeats"],
  ["keys", "more open, sustained chords"],
  ["bass", "busier, eighth notes"],
];

const own = { bass: "bass: 1 bar · 0:0/3X 6:0/2 8:0/3 14:4/2", keys: "keys: 1 bar · 0:0/3 0:2/3 0:4/3 6:0/2 6:2/2 6:4/2 12:0/2 12:2/2 12:4/2" };

async function band() {
  const runs = [];
  for (const [role, note] of NOTES) {
    const snapshot = `${SNAPSHOT}\nYour part (${role}) right now: ${own[role]}`;
    try {
      const r = JSON.parse(convex("run", "spikes:bandTurn", JSON.stringify({ role, snapshot, note })));
      runs.push({ role, note, ...r });
      console.log(`[band] ${role} "${note}": ${r.ms}ms ${r.tools.join("+")} → ${r.summary} · "${r.say}"`);
    } catch (e) {
      runs.push({ role, note, error: String(e.stderr ?? e.message).slice(0, 400) });
      console.log(`[band] ${role} "${note}": ERROR ${String(e.stderr ?? e.message).slice(0, 200)}`);
    }
  }
  const ms = runs.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
  const p50 = ms.length ? ms[Math.floor((ms.length - 1) / 2)] : null;
  const changed = runs.filter((r) => r.tools?.includes("set_pattern")).length;
  const out = { model: "claude-sonnet-5", at: new Date().toISOString(), p50Ms: p50, maxMs: ms.at(-1) ?? null, setPatternRuns: changed, runs };
  writeFileSync("docs/spikes/1b-band.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`[band] p50 ${p50}ms, max ${out.maxMs}ms, set_pattern in ${changed}/${runs.length} (bar: p50 ≤ 10000ms)`);
  return out;
}

async function design() {
  const wav = "samples/electric_piano_jd800_soft_ep.wav";
  const r = await runDesign({ wav, screenshot: `docs/spikes/1b-design-${designModel}.png` });
  const out = { model: designModel, at: new Date().toISOString(), wav: "electric_piano_jd800_soft_ep.wav", ...r };
  writeFileSync(`docs/spikes/1b-design-${designModel}.json`, JSON.stringify(out, null, 2) + "\n");
  console.log(`[design] ${r.outcome} in ${(r.wallMs / 1000).toFixed(1)}s; turns ${r.report?.turns?.join(",")}; no-tool turns ${r.report?.noToolTurns}`);
  return out;
}

try {
  if (doBand) await withRealModel("spike-1b band", band);
  if (doDesign) await withRealModel("spike-1b design", design, { DESIGN_MODEL: designModel });
} catch (e) {
  console.error(`[spike-1b] ${e.message}`);
  process.exitCode = 1;
}
