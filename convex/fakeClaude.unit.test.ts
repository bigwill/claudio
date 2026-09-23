/**
 * Slice 0 rail, unit layer (Node): the flag every fake path keys on.
 * `testing:*` and `llm.ts` both read it, so it must mean exactly "=== '1'".
 */
import { afterEach, expect, test, vi } from "vitest";

import { fakeLlmEnabled } from "./fakeClaude";

afterEach(() => vi.unstubAllEnvs());

test.each([
  ["1", true],
  ["", false],
  ["0", false],
  ["true", false],
])("CLAUDIO_FAKE_LLM=%j → %s", (value, expected) => {
  vi.stubEnv("CLAUDIO_FAKE_LLM", value);
  expect(fakeLlmEnabled()).toBe(expected);
});
