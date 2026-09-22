/**
 * Render duty: deciding whether THIS browser is on the hook right now.
 *
 * This is what replaced `drain()`. The old loop asked "what did the server tell
 * me to do next?" and kept going until it was told to stop. There is no such
 * answer any more — every mutation is fire-and-forget and the subscription is the
 * only source of truth — so the client answers exactly one question per snapshot:
 *
 *     is there a preset I am supposed to render, right now?
 *
 * Everything here has to be idempotent, because the same snapshot can arrive
 * repeatedly and the same state can be re-delivered after a reconnect.
 */

import type { ClaudioPreset } from "../shared/preset";
import { MAX_RENDER_MS, evaluateWithSpec } from "./audio";
import {
  claimRender,
  serverNow,
  submitAnalysis,
  submitRenderError,
  type Snapshot,
} from "./convex";
import { me } from "./identity";

interface RenderJob {
  /**
   * `${presetId}#${attemptNo}`, never presetId alone.
   *
   * attemptNo is the lease generation, and keying on it is load-bearing: keyed on
   * presetId only, a browser that tried once and failed would permanently
   * blacklist the very preset it may later be asked to rescue.
   */
  key: string;
  presetId: string;
  preset: ClaudioPreset;
}

const local = {
  /** Keys this tab has taken responsibility for. FIFO-capped; see evictions below. */
  attempted: new Set<string>(),
  order: [] as string[],
  rendering: null as RenderJob | null,
  /** ms epoch through which this tab expects to be making sound. */
  playingUntil: 0,
};

const ATTEMPTED_CAP = 64;

function remember(key: string): void {
  if (local.attempted.has(key)) return;
  local.attempted.add(key);
  local.order.push(key);
  // FIFO, deliberately NOT LRU: evicting the most-recently-touched key would
  // un-blacklist the one that is failing repeatedly and re-arm the hot loop it
  // was added to prevent.
  while (local.order.length > ATTEMPTED_CAP) {
    const oldest = local.order.shift()!;
    local.attempted.delete(oldest);
  }
}

/** Called from the keyboard so render duty can prefer someone who is not playing. */
export function notePlaying(): void {
  local.playingUntil = Date.now() + 3_000;
}

export const iAmPlaying = (): boolean => Date.now() < local.playingUntil;
export const playingUntil = (): number => local.playingUntil;
export const isRenderingHere = (): boolean => local.rendering !== null;

/** Milliseconds until the current render lease lapses, corrected for clock skew. */
export function msUntilLeaseExpiry(snap: Snapshot): number {
  const lease = snap.session?.render?.leaseUntil ?? 0;
  return lease - serverNow();
}

export interface RenderDeps {
  /** Make a preset audible locally. Awaits render-idle internally. */
  loadPreset: (preset: ClaudioPreset, presetId: string) => Promise<void>;
  /** Re-run reconciliation once this tab is free again. */
  reconcile: () => void;
}

/**
 * Decide, dispatch, and get out of the way.
 *
 * Synchronous by design: everything async is fired behind `local.rendering` and
 * re-enters through `deps.reconcile()` when it finishes. That single rule is what
 * replaced the old `state.busy` flag, and it is why N identical snapshots in one
 * tick collapse to one dispatch.
 */
export function maybeRender(snap: Snapshot, deps: RenderDeps): void {
  const s = snap.session;
  if (!s || s.status !== "awaiting_render" || !s.render || !s.renderSpec) return;
  if (local.rendering) return; // one render per tab, ever

  const { presetId, attemptNo, ownerClientId } = s.render;
  const key = `${presetId}#${attemptNo}`;
  if (local.attempted.has(key)) return;

  const attempt = snap.attempts.find((a) => a.presetId === presetId);
  if (!attempt) return; // the attempt row hasn't landed yet; next snapshot will have it

  if (ownerClientId === me.id) {
    // Reserve BEFORE any await, or repeated snapshots double-dispatch.
    remember(key);
    void run({ key, presetId, preset: attempt.preset }, snap, deps);
    return;
  }

  // Someone else owns it. Only consider taking over once their lease is dead.
  if (msUntilLeaseExpiry(snap) > 0) return;
  // Don't volunteer while making sound: Tone.Offline swaps the global context,
  // so rendering would cut this tab off mid-phrase. A silent tab loses nothing —
  // and needs no audio gesture for an offline render to work.
  if (iAmPlaying()) return;

  remember(key);
  void claimRender(s.slug, presetId).then((res) => {
    if (!res.granted) return deps.reconcile();
    const grantedKey = `${presetId}#${res.attemptNo}`;
    remember(grantedKey); // blacklist the GRANTED generation too, not just the old one
    void run({ key: grantedKey, presetId, preset: attempt.preset }, snap, deps);
  });
}

async function run(job: RenderJob, snap: Snapshot, deps: RenderDeps): Promise<void> {
  local.rendering = job;
  const s = snap.session!;
  const spec = s.renderSpec!;
  const slug = s.slug;
  const target = s.target;

  try {
    const { features, diff } = await evaluateWithSpec(job.preset, spec, target);

    /**
     * A silent or blown-up patch can measure as NaN, and Convex will happily
     * store that — it accepts non-finite numbers — after which the agent reads
     * "NaN" out of a JSON prompt and has no idea what happened. Route it into the
     * existing self-correction path instead, which is what that path is for.
     */
    if (!allFinite(features) || (diff && !Number.isFinite(diff.distance))) {
      throw new Error("render produced non-finite features (silent or unstable patch)");
    }

    // Load it the moment it's measured, so the newest patch is playable here
    // even before the agent has decided what to do next.
    await deps.loadPreset(job.preset, job.presetId);

    const res = await submitAnalysis({ slug, presetId: job.presetId, features, diff });
    // res.accepted === false means someone else got there first. That is normal
    // and deliberately silent — see the note in convex.ts.
    void res;
  } catch (err) {
    await submitRenderError({ slug, presetId: job.presetId, message: String(err) });
  } finally {
    local.rendering = null;
    // The only surviving trace of the old `while` loop: now that this tab is
    // free, ask the question again.
    deps.reconcile();
  }
}

function allFinite(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === "object") return Object.values(v).every(allFinite);
  return true;
}

/** Renders are capped at this much audio, which is what makes the lease short. */
export { MAX_RENDER_MS };
