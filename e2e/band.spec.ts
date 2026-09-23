/**
 * Slice 3 rails, E2E: S1 (create), S3 (start), S6 (scenes), keyboard-first.
 * Each test opens a fresh jam (a new slug). `?spy=1` records every instrument
 * call; `?bpm=200&bars=1` makes a landing take ~1.2s.
 */
import { expect, test, type Page } from "@playwright/test";

interface Call {
  g: number;
  time: number;
  track: string;
  method: string;
  note: number | string | null;
}
interface BandApi {
  ready: boolean;
  g: number;
  missedSteps: number;
  running: boolean;
  promotions: Array<{ g: number; track: string; id: string }>;
  calls: Call[];
  now(): number;
  view(): {
    phase: string;
    activeScene: string | null;
    strips: Array<{ role: string; sound: string | null; basedOn: number; muted: boolean }>;
  } | null;
}
/** The page's test interface; a local cast, since spike.spec declares its own. */
type W = { __band: BandApi };

const slug = () => `E2E${Math.random().toString(36).slice(2, 11).toUpperCase()}`;

async function openJam(page: Page, s = slug(), query = "?spy=1&bpm=200&bars=1") {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/${s}${query}`);
  await page.waitForFunction(() => (window as unknown as W).__band?.ready === true && (window as unknown as W).__band.view() !== null);
  return { slug: s, errors };
}

const view = (page: Page) => page.evaluate(() => (window as unknown as W).__band.view()!);
const strip = async (page: Page, role: string) => (await view(page)).strips.find((x) => x.role === role)!;

test("S1: a new jam opens in soundcheck with 4 strips and starter sounds; the transport stays stopped", async ({ page }) => {
  const { errors } = await openJam(page);
  const v = await view(page);
  expect(v.phase).toBe("soundcheck");
  expect(v.strips.map((x) => x.role).sort()).toEqual(["bass", "drums", "keys", "producer"]);
  for (const role of ["producer", "bass", "keys"]) expect((await strip(page, role)).sound).toBeTruthy();
  await expect(page.getByTestId("strip-bass")).toContainText((await strip(page, "bass")).sound!);
  await expect(page.getByTestId("phase")).toHaveText(/soundcheck/i);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as W).__band.running)).toBe(false);
  expect(errors).toEqual([]);
});

test("S1: in soundcheck, the keyboard auditions the focused strip; drums audition A=kick", async ({ page }) => {
  await openJam(page);
  await page.keyboard.press("Digit3");
  await page.keyboard.down("KeyA");
  await page.keyboard.up("KeyA");
  await page.keyboard.press("Digit2");
  await page.keyboard.press("KeyA");
  const calls = await page.evaluate(() => (window as unknown as W).__band.calls);
  expect(calls.some((c) => c.track === "bass" && c.method === "attack")).toBe(true);
  expect(calls.some((c) => c.track === "drums" && c.method === "hit" && c.note === "kick")).toBe(true);
});

test("S3: Space starts the jam: every part promotes at s=0, your keys sound at once and in key, 0 missed steps", async ({ page }) => {
  const { errors } = await openJam(page);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => (window as unknown as W).__band.running && (window as unknown as W).__band.g >= 18);
  await expect(page.getByTestId("phase")).toHaveText(/jam/i);
  const b = await page.evaluate(() => ({ promotions: (window as unknown as W).__band.promotions, calls: (window as unknown as W).__band.calls, missed: (window as unknown as W).__band.missedSteps }));
  expect(b.promotions.filter((p) => p.g === 0).map((p) => p.track).sort()).toEqual(["bass", "drums", "keys"]);
  const at0 = b.calls.filter((c) => c.g === 0 && c.track !== "you");
  expect(new Set(at0.map((c) => c.track))).toEqual(new Set(["drums", "bass", "keys"]));
  expect(new Set(at0.map((c) => Math.round(c.time * 1e6))).size).toBe(1);
  expect(b.missed).toBe(0);

  // In the jam, the keyboard always plays your strip, even with bass focused.
  await page.keyboard.press("Digit3");
  await page.keyboard.down("KeyA");
  await page.keyboard.up("KeyA");
  const you = (await page.evaluate(() => (window as unknown as W).__band.calls)).filter((c) => c.track === "you" && c.method === "attack");
  expect(you.map((c) => c.note)).toEqual([62]); // D4: D minor, octave 4, degree 0
  const now = await page.evaluate(() => (window as unknown as W).__band.now());
  expect(now - you[0].time).toBeGreaterThanOrEqual(-0.02);
  expect(errors).toEqual([]);
});

test("S6: save A, pick a new bass sound, save B, recall A: it lands on a bar line, A reads active, and after a reload A is still active and the transport stopped", async ({ page }) => {
  const { slug: s } = await openJam(page);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => (window as unknown as W).__band.running && (window as unknown as W).__band.g >= 2);
  const firstBass = (await strip(page, "bass")).sound;

  await page.keyboard.press("Shift+BracketLeft"); // save A
  await expect(page.getByTestId("scene-A")).toHaveAttribute("data-active", "true");

  await page.keyboard.press("Digit3");
  await page.keyboard.press("KeyB"); // library picker for bass
  await expect(page.getByTestId("picker")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction((first) => (window as unknown as W).__band.view()!.strips.find((x) => x.role === "bass")!.sound !== first, firstBass);
  const secondBass = (await strip(page, "bass")).sound;
  await expect(page.getByTestId("scene-A")).toHaveAttribute("data-active", "false");

  await page.keyboard.press("Shift+BracketRight"); // save B
  await expect(page.getByTestId("scene-B")).toHaveAttribute("data-active", "true");

  const before = await page.evaluate(() => (window as unknown as W).__band.promotions.length);
  await page.keyboard.press("BracketLeft"); // recall A
  await page.waitForFunction((first) => (window as unknown as W).__band.view()!.strips.find((x) => x.role === "bass")!.sound === first, firstBass);
  await expect(page.getByTestId("scene-A")).toHaveAttribute("data-active", "true");
  await page.waitForFunction((n) => (window as unknown as W).__band.promotions.slice(n).some((p) => p.track === "bass"), before);
  const landed = (await page.evaluate(() => (window as unknown as W).__band.promotions)).slice(before).filter((p) => p.track === "bass");
  expect(landed.every((p) => p.g % 16 === 0)).toBe(true);
  expect(secondBass).not.toBe(firstBass);

  await page.reload();
  await page.waitForFunction(() => (window as unknown as W).__band?.ready === true && (window as unknown as W).__band.view() !== null);
  expect((await view(page)).activeScene).toBe("A");
  await expect(page.getByTestId("scene-A")).toHaveAttribute("data-active", "true");
  expect(await page.evaluate(() => (window as unknown as W).__band.running)).toBe(false);
  expect(s).toBeTruthy();
});
