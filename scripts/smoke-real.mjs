/**
 * npm run smoke:real -- --yes
 *
 * Real Claude against the local deployment. It COSTS MONEY, so it runs only
 * with Will's go-ahead (slices 1b and 6) and refuses without --yes.
 *
 * Unsets CLAUDIO_FAKE_LLM, confirms `testing:ping` says fake:false, runs the
 * real-model scenarios, and always restores the flag (verified by a second
 * ping) so the dev loop never falls through to real Claude by accident.
 */
import { convex, ensureConvex, ping } from "./devstack.mjs";

if (!process.argv.includes("--yes")) {
  console.error("[smoke:real] spends real API money. Re-run with `npm run smoke:real -- --yes` once approved.");
  process.exit(2);
}

// Real-model scenarios (S2, S4, S5 and the headline) land in slices 1b and 6.
const SCENARIOS = [];

let code = 0;
await ensureConvex();
try {
  convex("env", "remove", "CLAUDIO_FAKE_LLM");
  const p = ping();
  if (p?.fake !== false) throw new Error(`expected fake:false after unsetting, got ${JSON.stringify(p)}`);
  console.log("[smoke:real] real Claude is live on the local deployment");
  if (SCENARIOS.length === 0) console.log("[smoke:real] no real-model scenarios yet (slices 1b and 6)");
  for (const s of SCENARIOS) await s();
} catch (e) {
  console.error(`[smoke:real] ${e.message}`);
  code = 1;
} finally {
  convex("env", "set", "CLAUDIO_FAKE_LLM", "1");
  const p = ping();
  if (p?.fake !== true) {
    console.error(`[smoke:real] FAILED TO RESTORE the fake flag (ping: ${JSON.stringify(p)}). Run: npx convex env set CLAUDIO_FAKE_LLM 1`);
    code = 1;
  } else {
    console.log("[smoke:real] fake flag restored");
  }
}
process.exit(code);
