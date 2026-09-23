/**
 * Drive one WAV design through today's app in a real browser (the browser does
 * the renders), and report its outcome. Used by spike-1b.mjs and
 * build-starters.mjs. Call inside withRealModel().
 *
 * RETIRED IN SLICE 3: this drives the pre-band app (deleted). Slice 4 brings it
 * back on designs.start. The starters it built are in src/shared/starterSounds.ts.
 */
import { chromium } from "playwright";

import { APP_URL, convex, ensureVite } from "./devstack.mjs";

export async function runDesign({ wav, tag = "design", screenshot = null }) {
  await ensureVite();
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const log = [];
  page.on("pageerror", (e) => log.push(`pageerror ${e.message}`));
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const t0 = Date.now();
  await page.setInputFiles("#file", wav);
  const deadline = t0 + 10 * 60_000;
  let status = "";
  let outcome = "timeout";
  while (Date.now() < deadline) {
    const body = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
    const s = body.match(/(Done —[^·]*|Thinking[^·]*|Rendering[^·]*|Ready\.|Waiting for a sample\.|The agent hit[^.]*\.|Claude call failed[^.]*)/)?.[0] ?? "";
    if (s !== status) {
      status = s;
      console.log(`[${tag}] +${((Date.now() - t0) / 1000).toFixed(1)}s ${s.slice(0, 80)}`);
    }
    if (/Done —/.test(s)) { outcome = "done"; break; }
    if (/hit its output|call failed/.test(s)) { outcome = "failed"; break; }
    // A no-tool turn in the refine loop stalls at "Ready." with no finalize (no guard until slice 4).
    if (/^Ready\./.test(s) && Date.now() - t0 > 15_000) { outcome = "stalled"; break; }
    await page.waitForTimeout(1000);
  }
  const wallMs = Date.now() - t0;
  const slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
  await browser.close();
  const report = slug ? JSON.parse(convex("run", "spikes:designReport", JSON.stringify({ slug }))) : null;
  return { outcome, wallMs, slug, report, log };
}
