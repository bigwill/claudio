/**
 * npm run smoke:real -- --yes
 *
 * Real Claude against the local deployment. It COSTS MONEY, so it runs only
 * with Will's go-ahead (slices 1b and 6) and refuses without --yes. The fake
 * flag is always restored (see withRealModel).
 */
import { withRealModel } from "./devstack.mjs";

if (!process.argv.includes("--yes")) {
  console.error("[smoke:real] spends real API money. Re-run with `npm run smoke:real -- --yes` once approved.");
  process.exit(2);
}

// Real-model scenarios (S2, S4, S5 and the headline) land in slice 6.
const SCENARIOS = [];

try {
  await withRealModel("smoke:real", async () => {
    if (SCENARIOS.length === 0) console.log("[smoke:real] no real-model scenarios yet (slice 6)");
    for (const s of SCENARIOS) await s();
  });
} catch (e) {
  console.error(`[smoke:real] ${e.message}`);
  process.exitCode = 1;
}
