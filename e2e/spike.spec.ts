/**
 * Slice 1 rails: the audio engine in a real browser, through the spike page.
 *
 * The page runs the real engine with spy-wrapped instruments. `window.__band`
 * is the plan's test interface (g, missedSteps, promotions, spy calls);
 * `window.__spike` holds spike-only hooks for staging variants and for the
 * stress and onset tests. Jams run at bars=1, bpm=200, so a loop is 1.2s.
 */
import { expect, test, type Page } from "@playwright/test";

type Track = "drums" | "bass" | "keys" | "you";
interface Call {
  g: number;
  time: number;
  track: Track;
  method: string;
  note: number | string | null;
}
interface Promo {
  g: number;
  track: Track;
  id: string;
}
interface BandApi {
  g: number;
  missedSteps: number;
  running: boolean;
  promotions: Promo[];
  calls: Call[];
  landsIn(track: Track): number | null;
  lastG(): number;
}
interface SpikeApi {
  ready: boolean;
  stage(track: Track, variant: string): void;
  flood(rows: number): void;
  redraw(times: number): void;
  designRender(): Promise<number>;
  /** The live context's currentTime. */
  now(): number;
  stopThenLateTick(): void;
  onsetTest(): Promise<{ sampleRate: number; expected: number[]; found: Array<number | null> }>;
}
declare global {
  interface Window {
    __band: BandApi;
    __spike: SpikeApi;
  }
}

const LOOP = 16; // bars=1

async function open(page: Page, bars = 1) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?spike=1&bpm=200&bars=${bars}`);
  await page.waitForFunction(() => window.__spike?.ready === true);
  return errors;
}

async function startBand(page: Page) {
  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.__band.running && window.__band.g >= 2);
}

const band = (page: Page) =>
  page.evaluate(() => ({
    g: window.__band.g,
    missedSteps: window.__band.missedSteps,
    running: window.__band.running,
    promotions: window.__band.promotions,
    calls: window.__band.calls,
  }));

/** Band-track calls grouped by step; live ("you") calls use immediate() and are excluded. */
function timesByStep(calls: Call[]): Map<number, Set<number>> {
  const by = new Map<number, Set<number>>();
  for (const c of calls) {
    if (c.track === "you") continue;
    if (!by.has(c.g)) by.set(c.g, new Set());
    by.get(c.g)!.add(Math.round(c.time * 1e6));
  }
  return by;
}

test("S3: every part promotes at s=0 on start, all tracks sound on the same time", async ({ page }) => {
  const errors = await open(page);
  await startBand(page);
  await page.waitForFunction((L) => window.__band.g >= L + 2, LOOP);
  const b = await band(page);
  expect(b.promotions.filter((p) => p.g === 0).map((p) => p.track).sort()).toEqual(["bass", "drums", "keys"]);
  const at0 = b.calls.filter((c) => c.g === 0);
  expect(new Set(at0.map((c) => c.track))).toEqual(new Set(["drums", "bass", "keys"]));
  expect(at0.some((c) => c.track === "drums" && c.method === "hit" && c.note === "kick")).toBe(true);
  for (const [, times] of timesByStep(b.calls)) expect(times.size).toBe(1);
  expect(b.missedSteps).toBe(0);
  expect(errors).toEqual([]);
});

test("S3: a staged change lands at the next bar line, exactly when the countdown said", async ({ page }) => {
  await open(page);
  await startBand(page);
  await page.waitForFunction(() => window.__band.g % 16 === 5);
  const staged = await page.evaluate(() => {
    window.__spike.stage("bass", "busy");
    return { lastG: window.__band.lastG(), landsIn: window.__band.landsIn("bass") };
  });
  expect(staged.landsIn).not.toBeNull();
  await page.waitForFunction(() => window.__band.promotions.some((p) => p.track === "bass" && p.id === "bass:busy"));
  const b = await band(page);
  const promo = b.promotions.find((p) => p.track === "bass" && p.id === "bass:busy")!;
  expect(promo.g).toBe(staged.lastG + 1 + staged.landsIn!);
  expect(promo.g % LOOP).toBe(0);
  expect(b.missedSteps).toBe(0);
});

test("S3: in a 4-bar loop, a change lands at the next bar line, not the loop line", async ({ page }) => {
  await open(page, 4);
  await startBand(page);
  await page.waitForFunction(() => window.__band.g % 64 === 21);
  const staged = await page.evaluate(() => {
    window.__spike.stage("bass", "busy");
    return { lastG: window.__band.lastG(), landsIn: window.__band.landsIn("bass") };
  });
  expect(staged.landsIn).toBeLessThanOrEqual(15);
  await page.waitForFunction(() => window.__band.promotions.some((p) => p.track === "bass" && p.id === "bass:busy"));
  const promo = (await band(page)).promotions.find((p) => p.track === "bass" && p.id === "bass:busy")!;
  expect(promo.g).toBe(staged.lastG + 1 + staged.landsIn!);
  expect(promo.g % 16).toBe(0);
  expect(promo.g % 64).not.toBe(0);
});

test("S3: your keys sound immediately, in key", async ({ page }) => {
  await open(page);
  await startBand(page);
  await page.keyboard.down("KeyA");
  await page.keyboard.up("KeyA");
  await page.keyboard.down("KeyD");
  await page.keyboard.up("KeyD");
  const you = (await band(page)).calls.filter((c) => c.track === "you");
  // D minor, octave 4: A = degree 0 = D4 (62), D = degree 2 = F4 (65).
  expect(you.filter((c) => c.method === "attack").map((c) => c.note)).toEqual([62, 65]);
  expect(you.filter((c) => c.method === "release").map((c) => c.note)).toEqual([62, 65]);
  // immediate(): no lookahead, so the attack is scheduled for (about) now.
  const now = await page.evaluate(() => window.__spike.now());
  for (const c of you) expect(now - c.time).toBeGreaterThanOrEqual(-0.02);
});

test("S3: stop then restart: nothing ticks after stop, and every part lands at g=0 again", async ({ page }) => {
  await open(page, 4);
  for (let round = 0; round < 4; round++) {
    await startBand(page);
    await page.waitForFunction(() => window.__band.g >= 20);
    // Stop, with the tick Tone's clock can still deliver up to the stop time
    // (which includes the lookahead). It must not move lastG off -1.
    await page.evaluate(() => window.__spike.stopThenLateTick());
    await page.waitForTimeout(400);
    const stopped = await page.evaluate(() => ({ lastG: window.__band.lastG(), promos: window.__band.promotions.length }));
    expect(stopped.lastG).toBe(-1);
    await page.evaluate((v) => window.__spike.stage("bass", v), round % 2 ? "a" : "busy");
    expect(await page.evaluate(() => window.__band.landsIn("bass"))).toBe(0);
    await startBand(page);
    const after = (await band(page)).promotions.slice(stopped.promos);
    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(after.every((p) => p.g === 0)).toBe(true);
    await page.keyboard.press("Space");
  }
});

test("S3: two keys on the same note: releasing one doesn't cut the other", async ({ page }) => {
  await open(page);
  await startBand(page);
  // Q is degree 7 (D5); K is also degree 7 on the home row.
  await page.keyboard.down("KeyQ");
  await page.keyboard.down("KeyK");
  await page.keyboard.up("KeyK");
  const mid = (await band(page)).calls.filter((c) => c.track === "you" && c.method === "release");
  expect(mid).toEqual([]);
  await page.keyboard.up("KeyQ");
  const end = (await band(page)).calls.filter((c) => c.track === "you" && c.method === "release");
  expect(end.map((c) => c.note)).toEqual([74]);
});

test("onset: a 1-bar part rendered through the real engine has its kicks on the grid", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => window.__spike.onsetTest());
  expect(r.found).toHaveLength(r.expected.length);
  expect(r.found.every((f) => f !== null)).toBe(true);
  const found = r.found as number[];
  // The master limiter (a DynamicsCompressor) adds a small fixed latency; the
  // grid itself must be sample-accurate: every onset shifted by the same amount.
  const latency = found[0] - r.expected[0];
  expect(latency).toBeGreaterThanOrEqual(-Math.round(0.001 * r.sampleRate));
  expect(latency).toBeLessThanOrEqual(Math.round(0.01 * r.sampleRate));
  r.expected.forEach((want, i) => {
    expect(Math.abs(found[i] - want - latency)).toBeLessThanOrEqual(Math.round(0.001 * r.sampleRate));
  });
});

test("S3s: under load, no step is missed and every track stays on one time per step", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await open(page);
  await startBand(page);

  const render = page.evaluate(() => window.__spike.designRender());
  await page.evaluate(() => window.__spike.flood(30));
  const variants = ["busy", "a"];
  for (let loop = 0; loop < 4; loop++) {
    const v = variants[loop % 2];
    await page.evaluate((v) => {
      window.__spike.stage("drums", v);
      window.__spike.stage("bass", v);
      window.__spike.stage("keys", v);
      window.__spike.redraw(20);
    }, v);
    for (const k of ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK"]) {
      await page.keyboard.down(k);
      await page.keyboard.up(k);
    }
    const g = (await band(page)).g;
    await page.waitForFunction(([g, L]) => window.__band.g >= g + L, [g, LOOP]);
  }
  await render;

  const b = await band(page);
  expect(b.running).toBe(true);
  expect(b.missedSteps).toBe(0);
  const bad = [...timesByStep(b.calls)].filter(([, t]) => t.size !== 1).map(([g]) => g);
  expect(bad).toEqual([]);
  expect(b.calls.some((c) => c.track === "you")).toBe(true);
  expect(b.promotions.filter((p) => p.g > 0).every((p) => p.g % 16 === 0)).toBe(true);
  expect(errors).toEqual([]);
});
