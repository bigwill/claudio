/**
 * Slice 0 rail, E2E layer placeholder: the page boots against the local
 * backend without a page error. Replaced by the S1 spec in slice 3.
 */
import { expect, test } from "@playwright/test";

test("the app boots with no page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page).toHaveTitle(/Claudio/i);
  expect(errors).toEqual([]);
});
