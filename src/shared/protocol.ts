/**
 * The shared contract between the browser and Convex.
 *
 * This file used to define ONE union — `Step` — that every HTTP endpoint
 * returned, and the whole client loop was driven by it. That is gone. State now
 * lives in a reactive document that every contributor subscribes to, so there is
 * no "next step" to return: a mutation writes, and everyone's subscription fires.
 * What survives here is the stuff both halves genuinely share — session ids,
 * identity, and the timing constants that the client's lease ticker and the
 * server's watchdog must agree on.
 *
 * Still true, and still load-bearing: this module must NOT import Tone, or
 * anything else. Convex functions import it.
 */

import type { ClaudioPreset } from "./preset";
import type { FeatureSummary } from "./features";

export type SessionStatus = "idle" | "thinking" | "awaiting_render" | "done" | "error";

export interface TargetInfo {
  filename: string;
  durationSec: number;
  sampleRate: number;
}

/**
 * How a preset must be rendered to be comparable within a session.
 *
 * Pinned once per session and used verbatim by every browser that renders for
 * it. `Tone.Offline` takes `sampleRate` explicitly, so a fixed spec is what makes
 * two contributors' measurements of the same preset mean the same thing —
 * otherwise a prompt-started session measures at whatever rate each contributor's
 * hardware happens to run at, and the FFT bin resolution differs underneath the
 * diff. (Lives here rather than in audio/render.ts because Convex mirrors it.)
 */
export interface RenderSpec {
  /** Fundamental to render at, in Hz. */
  f0: number;
  /** Total buffer length, ms. Capped at MAX_RENDER_MS by the renderer. */
  durationMs: number;
  /** Render sample rate. Never the live context's rate — see above. */
  sampleRate: number;
  /** Note-on duration, ms. Usually durationMs minus the amp release. */
  gateMs: number;
  /** 0..1, default 0.9. */
  velocity?: number;
}

export interface Attempt {
  /** The Anthropic tool_use id of the proposal that produced it. */
  presetId: string;
  preset: ClaudioPreset;
  rationale: string;
  /** null until some browser has rendered + analyzed this preset. */
  features: FeatureSummary | null;
  distance: number | null;
  /** Attribution only — both spoofable, never used for access control. */
  askedByClientId: string | null;
  measuredByClientId: string | null;
  isFinal: boolean;
}

/**
 * Suggested next moves, in the user's language ("glassier", "more punch").
 * Rendered as one-click chips so someone with both hands on the keyboard can
 * keep exploring without typing. Clicking one just sends it as a chat message,
 * so it needs no separate code path.
 */
export type Suggestions = string[];

/** How many chips to show, and what the agent is asked to produce. */
export const SUGGESTION_COUNT = 4;

/** Default iteration budget for the closed refine loop. */
export const MAX_ITERATIONS = 3;

// --- timing -----------------------------------------------------------------
//
// The client's lease ticker and the server's watchdog both read these, so they
// have to agree. A lease lapsing is NOT a database write, which means no
// subscription ever fires for it — the client polls these deadlines itself.

/**
 * How long a turn may hold the session before it's presumed dead. Sized for a
 * medium-effort claude-opus-5 turn with adaptive thinking, and comfortably above
 * the Anthropic SDK timeout set in convex/agent.ts (which is the real bound).
 */
export const TURN_LEASE_MS = 150_000;

/**
 * How long the assigned renderer has before anyone else may take over. Renders
 * are capped at MAX_RENDER_MS (2.5s of audio) and run far faster than realtime,
 * so this is generous — and it's short because a dead lease is dead air in a
 * loop that only lasts a minute.
 */
export const RENDER_LEASE_MS = 8_000;

/** After this many failed grants, close the tool call rather than retrying forever. */
export const MAX_RENDER_ATTEMPTS = 3;

/** Backstop cadence for sessions whose turn or render died without a trace. */
export const WATCHDOG_INTERVAL_MS = 30_000;

// --- session ids ------------------------------------------------------------

/**
 * Session ids appear in the URL (claudio.../<id>), so they are short and
 * typeable rather than UUIDs. Crockford-style alphabet: no I, L, O or U, so
 * nothing is ambiguous read aloud or transcribed, and no accidental words.
 *
 * 12 chars over a 32-symbol alphabet is 60 bits. These are unguessable enough
 * that an unlisted session won't be stumbled into, but this is NOT auth — the
 * app is open, and anyone with the link has the session. That matters more now
 * that "having the link" means being able to drive the agent, not just watch.
 */
const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SESSION_ID_LENGTH = 12;

export function newSessionId(): string {
  const bytes = new Uint8Array(SESSION_ID_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/** Is this path segment shaped like one of our session ids? */
export function looksLikeSessionId(s: string): boolean {
  return s.length === SESSION_ID_LENGTH && [...s].every((c) => ID_ALPHABET.includes(c));
}
