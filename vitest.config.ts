import { defineConfig } from "vitest/config";

/**
 * Two Vitest projects, fastest first (plan: "Testing story"):
 * - unit: pure modules in Node, colocated with their source as `*.test.ts`
 *   under src/, or `*.unit.test.ts` under convex/ (the pure plan* functions).
 * - convex: real Convex functions against convex-test's in-memory backend.
 *   convex-test needs the edge-runtime environment and must be inlined.
 * Convex skips any file whose name has more than one dot, so neither kind of
 * test file is ever deployed as a function module.
 * Playwright E2E lives in e2e/ and runs separately (`npm run e2e`).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "convex/**/*.unit.test.ts"],
        },
      },
      {
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["convex/**/*.test.ts"],
          exclude: ["convex/**/*.unit.test.ts"],
          server: { deps: { inline: ["convex-test"] } },
        },
      },
    ],
  },
});
