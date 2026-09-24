/**
 * npm run smoke:real -- --yes [--runs=3]
 *
 * The headline (docs/headline.md) on REAL models against the local deployment:
 * S2 (a WAV design on Opus 5.5), S4 ("@bass busier"), S5 ("@keys make it
 * glassier", then ← restores), and scenes. Reports design wall time and
 * no-tool strikes, band reply latency (p50), whether each note changed the
 * part, and screenshots (test-results/smoke/). The bar (plan §Testing):
 * band median ≤ 10s and 3 of 3 headline runs.
 *
 * Costs money (~$1 per run); under $50 runs are pre-approved. Refuses without
 * --yes. The fake flag is always restored afterwards (withRealModel).
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

import { APP_URL, convex, ensureVite, withRealModel } from "./devstack.mjs";

if (!process.argv.includes("--yes")) {
  console.error("[smoke:real] spends real API money. Re-run with `npm run smoke:real -- --yes`.");
  process.exit(2);
}
const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? 3);
mkdirSync("test-results/smoke", { recursive: true });

const view = (p) => p.evaluate(() => window.__band.view());
const strip = async (p, role) => (await view(p)).strips.find((x) => x.role === role);
const designing = (p, role, want, timeout) =>
  p.waitForFunction(([r, w]) => window.__band.view().strips.find((x) => x.role === r).designing === w, [role, want], { timeout });
const soundIs = (p, role, name, timeout) =>
  p.waitForFunction(([r, n]) => window.__band.view().strips.find((x) => x.role === r).sound === n, [role, name], { timeout });

async function say(p, key, text) {
  await p.keyboard.press(key);
  await p.keyboard.press("Enter");
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
  await p.keyboard.press("Escape");
}

/** Send a note and time the musician's answer (a reply row, or a failure row). */
async function note(p, role, key, text, latencies) {
  // Count only rows that arrive AFTER this note: an earlier "keys now plays …"
  // system row must not read as keys answering (it did, in the first runs).
  const n0 = await p.locator(`[data-testid=reply-${role}]`).count();
  const s0 = await p.locator(".msg.system").count();
  const before = (await strip(p, role)).basedOn;
  const t0 = Date.now();
  await say(p, key, text);
  await p.waitForFunction(
    ([r, n, sn]) =>
      document.querySelectorAll(`[data-testid=reply-${r}]`).length > n ||
      [...document.querySelectorAll(".msg.system")].slice(sn).some((e) => e.textContent.startsWith(r + " ")),
    [role, n0, s0],
    { timeout: 60_000 },
  );
  const ms = Date.now() - t0;
  latencies.push(ms);
  await p.waitForTimeout(300);
  const after = await strip(p, role);
  const reply = (await p.locator(`[data-testid=reply-${role}]`).last().innerText().catch(() => "")).replace(/\s+/g, " ");
  return { ms, changed: after.basedOn !== before, sound: after.sound, reply };
}

async function headline(run, latencies) {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1512, height: 862 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  try {
    await p.goto(`${APP_URL}/SMOKE${Date.now().toString(36).toUpperCase()}`);
    await p.waitForFunction(() => window.__band?.ready && window.__band.view());

    // 1. Soundcheck: design keys from the EP WAV (S2).
    const t0 = Date.now();
    const keys0 = (await strip(p, "keys")).sound;
    await p.keyboard.press("Digit4");
    await p.setInputFiles("[data-testid=design-file]", "samples/electric_piano_jd800_soft_ep.wav");
    await designing(p, "keys", true, 15_000);
    await designing(p, "keys", false, 150_000);
    const designS = (Date.now() - t0) / 1000;
    const keys1 = (await strip(p, "keys")).sound;
    const d = JSON.parse(convex("data", "designs", "--limit", "1", "--order", "desc", "--format", "jsonLines").trim() || "{}");
    check("S2 design finishes and keys plays it", keys1 !== keys0 && d.status === "done", `${designS.toFixed(1)}s → ${keys1}; no-tool strikes ${d.noToolStrikes ?? "?"}`);
    await p.screenshot({ path: `test-results/smoke/run${run}-1-soundcheck.png` });

    // 2. The jam starts.
    await p.keyboard.press("Space");
    await p.waitForFunction(() => window.__band.running && window.__band.g >= 2);

    // 3. S4.
    const bass = await note(p, "bass", "Digit3", "busier, eighth notes", latencies);
    check("S4 bass changes its part", bass.changed, `${(bass.ms / 1000).toFixed(1)}s · "${bass.reply}"`);

    // 4. S5: glassier → a tweak; one too far; ← restores the good one.
    const g = await note(p, "keys", "Digit4", "make it glassier", latencies);
    check("S5 keys tweaks its sound", g.changed && g.sound !== keys1, `${(g.ms / 1000).toFixed(1)}s → ${g.sound} · "${g.reply}"`);
    const far = await note(p, "keys", "Digit4", "even glassier, really metallic", latencies);
    check("S5 one more try lands", far.changed, `${(far.ms / 1000).toFixed(1)}s → ${far.sound}`);
    await p.keyboard.press("Digit4");
    await p.keyboard.press("ArrowLeft");
    await soundIs(p, "keys", g.sound, 10_000).then(
      () => check("S5 ← brings the good version back", true, g.sound),
      () => check("S5 ← brings the good version back", false),
    );
    await p.screenshot({ path: `test-results/smoke/run${run}-4-keys.png` });

    // 5. Scenes.
    await p.keyboard.press("Shift+BracketLeft");
    const drums = await note(p, "drums", "Digit2", "half-time, sparse", latencies);
    check("drums reshape", drums.changed, `${(drums.ms / 1000).toFixed(1)}s · "${drums.reply}"`);
    await p.keyboard.press("Shift+BracketRight");
    await p.keyboard.press("BracketLeft");
    await p.waitForTimeout(600);
    const a = (await view(p)).activeScene;
    await p.keyboard.press("BracketRight");
    await p.waitForTimeout(600);
    check("scenes A/B flip", a === "A" && (await view(p)).activeScene === "B");
    await p.screenshot({ path: `test-results/smoke/run${run}-5-scenes.png` });
    check("no page errors, no missed steps", errors.length === 0 && (await p.evaluate(() => window.__band.missedSteps)) === 0, errors.join("; "));
  } catch (e) {
    check("run completed", false, String(e.message ?? e).split("\n")[0]);
    await p.screenshot({ path: `test-results/smoke/run${run}-failed.png` }).catch(() => {});
  } finally {
    await b.close();
  }
  return checks.every((c) => c.ok);
}

let passed = 0;
const latencies = [];
try {
  await withRealModel("smoke:real", async () => {
    await ensureVite();
    for (let run = 1; run <= runs; run++) {
      console.log(`[smoke:real] headline run ${run}/${runs}`);
      if (await headline(run, latencies)) passed++;
    }
  });
} catch (e) {
  console.error(`[smoke:real] ${e.message}`);
}
const sorted = [...latencies].sort((a, b) => a - b);
const p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] / 1000 : NaN;
console.log(`[smoke:real] ${passed}/${runs} headline runs passed · band reply p50 ${p50.toFixed(1)}s over ${sorted.length} notes (bar: 3/3 and ≤ 10s)`);
process.exitCode = passed === runs && p50 <= 10 ? 0 : 1;
