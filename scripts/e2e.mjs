/**
 * npm run e2e [-- <playwright args, e.g. --grep S3>]
 *
 * 1. Boot local Convex (via `convex dev`) and Vite if they aren't running.
 * 2. Set CLAUDIO_FAKE_LLM=1 and preflight `testing:ping`: abort unless it
 *    answers fake:true, so a real model is never driven by the suite.
 * 3. Clear fake scripts (and, from slice 3, the test jams).
 * 4. Run Playwright.
 */
import { spawnSync } from "node:child_process";

import { convex, ensureConvex, ensureVite, ping, stopBooted } from "./devstack.mjs";

let code = 1;
try {
  await ensureConvex();
  convex("env", "set", "CLAUDIO_FAKE_LLM", "1");
  const p = ping();
  if (p === null) {
    throw new Error("preflight: testing:ping isn't deployed. Is `npx convex dev` running and current?");
  }
  if (p.fake !== true) {
    throw new Error(`preflight: testing:ping returned ${JSON.stringify(p)}, not fake:true. Aborting.`);
  }
  console.log("[e2e] preflight ok: fake LLM");
  await ensureVite();
  convex("run", "testing:clearScripts");
  code = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1;
} catch (e) {
  console.error(`[e2e] ${e.message}`);
} finally {
  stopBooted();
}
process.exit(code);
