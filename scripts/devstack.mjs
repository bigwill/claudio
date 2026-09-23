/**
 * Shared plumbing for the e2e and smoke:real runners: talk to the local Convex
 * deployment through the CLI, and boot `convex dev` / Vite when they aren't up.
 *
 * A local anonymous deployment's backend is owned by `npx convex dev`, so "the
 * backend answers" means a `convex dev` is running and pushing functions.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

export const CONVEX_URL = env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
export const APP_URL = process.env.CLAUDIO_URL ?? "http://localhost:5173";

export function convex(...args) {
  return execFileSync("npx", ["convex", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `testing:ping`, or null if the function isn't deployed or the backend is down. */
export function ping() {
  try {
    return JSON.parse(convex("run", "testing:ping"));
  } catch {
    return null;
  }
}

async function answers(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function waitFor(what, check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}

const children = [];

function boot(name, cmd, args) {
  mkdirSync("test-results", { recursive: true });
  const log = openSync(`test-results/${name}.log`, "w");
  console.log(`[devstack] starting ${name} (log: test-results/${name}.log)`);
  // Own process group, so stopping it takes the local backend `convex dev`
  // spawned with it. Killing only npx would orphan the backend on :3210.
  children.push(spawn(cmd, args, { stdio: ["ignore", log, log], detached: true }));
}

export function stopBooted() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

export async function ensureConvex() {
  if (await answers(`${CONVEX_URL}/version`)) return;
  boot("convex-dev", "npx", ["convex", "dev", "--tail-logs", "disable"]);
  await waitFor("convex dev to push functions", () => ping() !== null, 120_000);
}

export async function ensureVite() {
  if (await answers(APP_URL)) return;
  boot("vite", "npx", ["vite", "dev", "--port", new URL(APP_URL).port || "5173", "--strictPort"]);
  await waitFor("vite", () => answers(APP_URL), 60_000);
}
