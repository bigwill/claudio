import { defineConfig } from "@playwright/test";

/**
 * Browser E2E against local Convex + Vite + the fake LLM. Run it through
 * `npm run e2e`, which sets the fake flag, preflights `testing:ping`, and boots
 * whatever isn't already running. `--grep` runs one slice's scenarios.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.CLAUDIO_URL ?? "http://localhost:5173",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
    trace: "retain-on-failure",
  },
});
