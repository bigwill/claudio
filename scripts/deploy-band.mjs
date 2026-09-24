/**
 * npm run deploy:band — the hosted Claudio Band (feature/band) for showing
 * people, on its own worker (`claudio-band`) so `claudio` / `claudio-prod`
 * stay untouched for interviews.
 *
 *   1. push the Convex backend to the cloud deployment named in .env.band.
 *      `convex dev --once` REWRITES .env.local to the deployment it pushed to,
 *      which silently repointed local dev at the cloud once (2026-09-23), so
 *      .env.local is snapshotted first and always restored;
 *   2. build the app against that deployment's URL (VITE_CONVEX_URL);
 *   3. deploy the built assets as the `claudio-band` worker (wrangler env "band").
 *
 * Needs `npx convex login` and `npx wrangler login` on this machine.
 * .env.band is gitignored: CONVEX_DEPLOYMENT=dev:… and VITE_CONVEX_URL=https://….convex.cloud
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.band", "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);
for (const k of ["CONVEX_DEPLOYMENT", "VITE_CONVEX_URL"]) {
  if (!env[k]) throw new Error(`.env.band is missing ${k}`);
}
const run = (cmd, args, extra = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...extra } });

console.log(`[deploy:band] backend → ${env.CONVEX_DEPLOYMENT}`);
const localEnv = readFileSync(".env.local", "utf8");
try {
  run("npx", ["convex", "dev", "--once", "--typecheck", "disable"], { CONVEX_DEPLOYMENT: env.CONVEX_DEPLOYMENT });
} finally {
  if (readFileSync(".env.local", "utf8") !== localEnv) {
    writeFileSync(".env.local", localEnv);
    console.log("[deploy:band] restored .env.local (convex dev had repointed it at the cloud deployment)");
  }
}
console.log(`[deploy:band] build against ${env.VITE_CONVEX_URL}`);
run("npx", ["vite", "build"], { VITE_CONVEX_URL: env.VITE_CONVEX_URL });
console.log("[deploy:band] worker claudio-band");
run("npx", ["wrangler", "deploy", "--env", "band"]);
