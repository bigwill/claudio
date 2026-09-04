import { chromium } from "playwright";

/**
 * Offline smoke test for the whole loop.
 *
 *   npm run dev          # in one shell
 *   npm run verify:loop  # in another
 *
 * Drives a real browser because the RENDER is the part worth verifying: it
 * happens in Web Audio, in the page, and nothing in Node can stand in for it.
 * Exits non-zero unless an attempt comes back with a measured feature vector.
 *
 * Assumes CLAUDIO_FAKE_LLM=1 on the deployment, so no network is needed.
 */
const URL = process.env.CLAUDIO_URL ?? "http://localhost:5173";
const logs = [];

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();

page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// Kick a prompt-started session: no audio file needed.
const box = await page.$("#promptbox");
if (!box) {
  console.log("NO PROMPTBOX. body text:");
  console.log((await page.textContent("body"))?.slice(0, 800));
  await page.screenshot({ path: "/tmp/claudio-verify/00-noprompt.png" });
  await browser.close();

if (!measured) {
  console.error("\nFAIL: no attempt reached 'measured' within 90s.");
  process.exit(1);
}
console.log("\nPASS: a render completed and was measured in the browser.");
  process.exit(2);
}

await page.screenshot({ path: "/tmp/claudio-verify/01-loaded.png" });

await box.fill("a glassy bell");
await page.click("#promptgo");
console.log("prompt submitted, watching for a render…");

// Poll the visible state for up to 90s.
const deadline = Date.now() + 90_000;
let measured = false;
let last = "";
while (Date.now() < deadline) {
  const txt = (await page.textContent("body")) ?? "";
  const sig = txt.replace(/\s+/g, " ").slice(0, 300);
  if (sig !== last) {
    console.log("  ui: " + sig.slice(0, 200));
    last = sig;
  }
  if (/measured by/i.test(txt)) { measured = true; break; }
  await page.waitForTimeout(2000);
}

await page.screenshot({ path: "/tmp/claudio-verify/02-after.png", fullPage: true });

console.log("\n--- console (last 40) ---");
console.log(logs.slice(-40).join("\n"));

await browser.close();

if (!measured) {
  console.error("\nFAIL: no attempt reached 'measured' within 90s.");
  process.exit(1);
}
console.log("\nPASS: a render completed and was measured in the browser.");
