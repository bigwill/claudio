/**
 * The only module that knows Convex exists.
 *
 * Two halves: a subscription manager that turns three live queries into one
 * coalesced snapshot, and mutation wrappers that never throw at the call site.
 *
 * That second part is a deliberate policy. There is no call site in this app
 * where a failed mutation should abort what the user was doing — and, crucially,
 * some failures are ENTIRELY NORMAL. Losing a render race returns
 * `{accepted:false}`, and that must stay silent: it is two browsers being
 * helpful, not an error. Only genuine user-facing conflicts (ConvexError) get
 * surfaced.
 */

import { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { FeatureDiff, FeatureSummary } from "../shared/features";
import type { ClaudioPreset } from "../shared/preset";
import type {
  ChatKind,
  ChatStatus,
  RenderSpec,
  SessionStatus,
  TargetInfo,
} from "../shared/protocol";
import { me } from "./identity";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
if (!url) {
  throw new Error("VITE_CONVEX_URL is not set — run `npx convex dev` to configure a deployment.");
}

export const convex = new ConvexClient(url, {
  // Messages queue server-side on purpose; a browser-level "unsaved changes"
  // dialog on top of that is noise, not safety.
  unsavedChangesWarning: false,
});

// --- the shapes the client reads -------------------------------------------

export interface ChatView {
  id: string;
  seq: number;
  kind: ChatKind;
  status: ChatStatus;
  text: string;
  authorClientId: string | null;
  nickname: string | null;
  color: string | null;
  aboutPresetId: string | null;
  suggestions: string[];
}

export interface RenderDuty {
  presetId: string;
  ownerClientId: string | null;
  /** ABSOLUTE server-clock deadline. See the note on skew below. */
  leaseUntil: number;
  attemptNo: number;
}

export interface SessionView {
  sessionId: Id<"sessions">;
  slug: string;
  status: SessionStatus;
  statusSince: number;
  target: FeatureSummary | null;
  targetInfo: TargetInfo | null;
  hasTargetAudio: boolean;
  promptText: string | null;
  renderSpec: RenderSpec | null;
  iteration: number;
  maxIterations: number;
  bestPresetId: string | null;
  bestDistance: number | null;
  lastError: string | null;
  lastErrorRetryable: boolean;
  turnStartedBy: string | null;
  render: RenderDuty | null;
  chat: ChatView[];
  queuedCount: number;
}

export interface AttemptView {
  presetId: string;
  iteration: number;
  preset: ClaudioPreset;
  rationale: string;
  features: FeatureSummary | null;
  distance: number | null;
  askedByClientId: string | null;
  measuredByClientId: string | null;
  isFinal: boolean;
}

export interface PeerView {
  clientId: string;
  nickname: string;
  color: string;
  joinedAt: number;
  lastSeen: number;
}

export interface Snapshot {
  session: SessionView | null;
  attempts: AttemptView[];
  peers: PeerView[];
  /** True once the session query has answered at all — "not loaded" vs "missing". */
  loaded: boolean;
}

// --- clock skew -------------------------------------------------------------

/**
 * Lease deadlines are server timestamps, and this browser's clock may be wrong
 * by minutes. `heartbeat` returns the server's clock (a mutation result, never
 * cached — unlike a query, where reading Date.now() is a documented Convex
 * anti-pattern), and we track the offset from it.
 */
let clockOffset = 0;
export const serverNow = (): number => Date.now() + clockOffset;
const noteServerTime = (now: number) => {
  clockOffset = now - Date.now();
};

// --- subscription -----------------------------------------------------------

export type OnSnapshot = (s: Snapshot) => void;
export type OnFailure = (message: string) => void;

export function subscribeSession(
  slug: string,
  onSnapshot: OnSnapshot,
  onFailure: OnFailure,
): () => void {
  const snap: Snapshot = { session: null, attempts: [], peers: [], loaded: false };
  let peersUnsub: (() => void) | null = null;
  let peersFor: string | null = null;

  /**
   * Convex delivers every subscription callback for one transition in the same
   * task and at the same logical timestamp, so a microtask flush coalesces them
   * into a single reconcile. An extra pass would be harmless anyway — reconcile
   * is idempotent — but this keeps the common case to one render.
   */
  let queued = false;
  const bump = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      onSnapshot(snap);
    });
  };

  const fail = (e: Error) => onFailure(describe(e));

  const unsubState = convex.onUpdate(
    api.sessions.state,
    { slug },
    (v) => {
      snap.session = (v as SessionView | null) ?? null;
      snap.loaded = true;

      // Presence is keyed by the Convex id, which we only learn from the session
      // query — so it is subscribed lazily, and kept SEPARATE. Folding presence
      // into the session query would re-push every chat row to everyone on each
      // 10-second heartbeat, from every contributor.
      const id = snap.session?.sessionId ?? null;
      if (id && peersFor !== id) {
        peersUnsub?.();
        peersFor = id;
        peersUnsub = convex.onUpdate(
          api.presence.list,
          { sessionId: id },
          (p) => {
            snap.peers = (p as PeerView[]) ?? [];
            bump();
          },
          fail,
        );
      }
      bump();
    },
    fail,
  );

  const unsubAttempts = convex.onUpdate(
    api.sessions.attempts,
    { slug },
    (v) => {
      snap.attempts = (v as AttemptView[]) ?? [];
      bump();
    },
    fail,
  );

  return () => {
    unsubState();
    unsubAttempts();
    peersUnsub?.();
  };
}

// --- mutations --------------------------------------------------------------

function describe(e: unknown): string {
  if (e instanceof ConvexError) {
    const d = e.data as { message?: string; code?: string } | string;
    if (typeof d === "string") return d;
    return d?.message ?? d?.code ?? "rejected";
  }
  return e instanceof Error ? e.message : String(e);
}

let reportError: OnFailure = () => {};
export function setErrorReporter(fn: OnFailure): void {
  reportError = fn;
}

/** Resolves to a result or null; never rejects at the call site. */
async function call<T>(fn: () => Promise<T>, what: string): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    reportError(`${what}: ${describe(e)}`);
    return null;
  }
}

export const createSession = (slug: string) =>
  call(() => convex.mutation(api.sessions.create, { slug, author: me.wire() }), "create session");

export const setTarget = (args: {
  slug: string;
  features: FeatureSummary;
  info: TargetInfo;
  spec: RenderSpec;
  audioId: Id<"_storage"> | null;
}) => call(() => convex.mutation(api.sessions.setTarget, { ...args, author: me.wire() }), "set target");

export const startFromPrompt = (args: { slug: string; prompt: string; spec: RenderSpec }) =>
  call(
    () => convex.mutation(api.sessions.startFromPrompt, { ...args, author: me.wire() }),
    "start",
  );

export const sendChat = (slug: string, text: string, aboutPresetId: string | null) =>
  call(
    () => convex.mutation(api.chat.send, { slug, text, aboutPresetId, author: me.wire() }),
    "send",
  );

export const cancelQueued = (slug: string, chatId: string) =>
  call(
    () =>
      convex.mutation(api.chat.cancelQueued, {
        slug,
        chatId: chatId as Id<"chat">,
        clientId: me.id,
      }),
    "cancel",
  );

export const forkSession = (fromSlug: string, newSlug: string, presetId: string | null) =>
  call(
    () => convex.mutation(api.sessions.fork, { fromSlug, newSlug, presetId, author: me.wire() }),
    "fork",
  );

/**
 * Losing this race is normal traffic — two browsers both being useful — so the
 * caller gets a plain false rather than an error anyone has to look at.
 */
export const claimRender = async (slug: string, presetId: string) =>
  (await call(
    () => convex.mutation(api.render.claimRender, { slug, presetId, clientId: me.id }),
    "claim render",
  )) ?? { granted: false, attemptNo: 0 };

export const submitAnalysis = async (args: {
  slug: string;
  presetId: string;
  features: FeatureSummary;
  // Explicitly null, never undefined: Convex stores an absent key as undefined,
  // and the server branches on `diff ? … : …`.
  diff: FeatureDiff | null;
}) =>
  (await call(
    () => convex.mutation(api.render.submitAnalysis, { ...args, clientId: me.id }),
    "submit measurement",
  )) ?? { accepted: false };

export const submitRenderError = async (args: {
  slug: string;
  presetId: string;
  message: string;
}) =>
  (await call(
    () => convex.mutation(api.render.submitRenderError, { ...args, clientId: me.id }),
    "report render failure",
  )) ?? { accepted: false };

export async function heartbeat(sessionId: Id<"sessions">, playingUntil: number): Promise<void> {
  try {
    const res = await convex.mutation(api.presence.heartbeat, {
      sessionId,
      clientId: me.id,
      nickname: me.nickname,
      color: me.color,
      playingUntil,
    });
    if (res?.now) noteServerTime(res.now);
  } catch {
    /* a dropped beat is not worth a message; the next one is 10s away */
  }
}

export function leave(sessionId: Id<"sessions">): void {
  // Fire-and-forget: this runs from pagehide, where nothing can be awaited.
  void convex.mutation(api.presence.leave, { sessionId, clientId: me.id }).catch(() => {});
}

export async function uploadTargetAudio(bytes: ArrayBuffer): Promise<Id<"_storage"> | null> {
  const postUrl = await call(
    () => convex.mutation(api.sessions.generateTargetUploadUrl, {}),
    "prepare audio upload",
  );
  if (!postUrl) return null;
  try {
    const res = await fetch(postUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
    return storageId;
  } catch (e) {
    // Not fatal: the session still works, joiners just can't hear the sample.
    reportError(`target audio upload failed: ${describe(e)}`);
    return null;
  }
}

export async function targetAudioUrl(slug: string): Promise<string | null> {
  return await call(() => convex.query(api.sessions.targetAudioUrl, { slug }), "load target audio");
}
