/**
 * The only module that talks to Convex (plan §7). Everything the band UI
 * reads is a reactive subscription; everything it writes is a mutation.
 */
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { FeatureDiff, FeatureSummary } from "../shared/features";
import type { RenderSpec } from "../shared/protocol";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
if (!url) throw new Error("VITE_CONVEX_URL is not set — run `npx convex dev` to configure a deployment.");

/**
 * In dev, dial the page's own origin: Vite proxies /api to the local backend
 * (vite.config.ts), which is what makes the jam reachable from another machine.
 */
export const convexUrl = import.meta.env.DEV ? location.origin : url;
export const convex = new ConvexClient(convexUrl, { skipConvexDeploymentUrlCheck: true });

export type JamState = NonNullable<FunctionReturnType<typeof api.jams.state>>;
export type Strip = JamState["musicians"][number];
export type ChatRow = FunctionReturnType<typeof api.jams.chat>[number];
export type Pip = FunctionReturnType<typeof api.parts.rail>[number];
export type LibraryRow = FunctionReturnType<typeof api.library.list>[number];
export type MusicianId = Id<"musicians">;
export type JamId = Id<"jams">;
export type HistoryMove =
  | { kind: "step"; dir: -1 | 1 }
  | { kind: "oldest" }
  | { kind: "newest" }
  | { kind: "jump"; version: number };

export type RenderJob = NonNullable<FunctionReturnType<typeof api.designs.renderJob>>;

/** This tab's render identity: claimRender is first-caller-wins across tabs and browsers. */
export const clientId = crypto.randomUUID();

export const band = {
  create: (slug: string, opts: { bpm?: number; bars?: 1 | 2 | 4 }) => convex.mutation(api.jams.create, { slug, ...opts }),
  onState: (slug: string, cb: (s: JamState | null) => void) => convex.onUpdate(api.jams.state, { slug }, cb),
  onChat: (jamId: JamId, cb: (rows: ChatRow[]) => void) => convex.onUpdate(api.jams.chat, { jamId }, cb),
  onRail: (musicianId: MusicianId, cb: (pips: Pip[]) => void) => convex.onUpdate(api.parts.rail, { musicianId }, cb),
  library: (role: "bass" | "keys" | "pitched") => convex.query(api.library.list, { role }),
  start: (jamId: JamId) => convex.mutation(api.jams.start, { jamId }),
  saveScene: (jamId: JamId, scene: "A" | "B") => convex.mutation(api.jams.saveScene, { jamId, scene }),
  recallScene: (jamId: JamId, scene: "A" | "B") => convex.mutation(api.jams.recallScene, { jamId, scene }),
  setBpm: (jamId: JamId, bpm: number) => convex.mutation(api.jams.setBpm, { jamId, bpm }),
  setReactive: (jamId: JamId, reactive: boolean) => convex.mutation(api.jams.setReactive, { jamId, reactive }),
  pick: (musicianId: MusicianId, libraryId: Id<"library">) => convex.mutation(api.parts.pick, { musicianId, libraryId }),
  history: (musicianId: MusicianId, move: HistoryMove) => convex.mutation(api.parts.history, { musicianId, move }),
  setMuted: (musicianId: MusicianId, muted: boolean) => convex.mutation(api.musicians.setMuted, { musicianId, muted }),
  send: (jamId: JamId, text: string, octave: number) => convex.mutation(api.chat.send, { jamId, text, octave }),
};

export const design = {
  startWav: (
    musicianId: MusicianId,
    features: FeatureSummary,
    info: { filename: string; durationSec: number; sampleRate: number },
    audioId: Id<"_storage"> | null,
    spec: RenderSpec,
  ) => convex.mutation(api.designs.start, { musicianId, source: { kind: "wav", features, info, audioId }, spec }),
  startPrompt: (musicianId: MusicianId, text: string, spec: RenderSpec) =>
    convex.mutation(api.designs.start, { musicianId, source: { kind: "prompt", text }, spec }),
  cancel: (designId: Id<"designs">) => convex.mutation(api.designs.cancel, { designId }),
  renderJob: (designId: Id<"designs">) => convex.query(api.designs.renderJob, { designId }),
  claim: (designId: Id<"designs">, presetId: string) => convex.mutation(api.render.claimRender, { designId, clientId, presetId }),
  submit: (designId: Id<"designs">, presetId: string, features: FeatureSummary, diff: FeatureDiff | null) =>
    convex.mutation(api.render.submitAnalysis, { designId, clientId, presetId, features, diff }),
  renderError: (designId: Id<"designs">, presetId: string, message: string) =>
    convex.mutation(api.render.submitRenderError, { designId, clientId, presetId, message: message.slice(0, 500) }),
  /** Store the prepared target audio (16-bit PCM) so the rail can play it after a reload. */
  async upload(bytes: ArrayBuffer): Promise<Id<"_storage">> {
    const url = await convex.mutation(api.designs.generateUploadUrl, {});
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
  },
};

/** Mutations throw ConvexError with a message meant for people; surface it. */
export function errorText(e: unknown): string {
  const data = (e as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  return e instanceof Error ? e.message.replace(/^.*Uncaught ConvexError: /s, "").split("\n")[0] : String(e);
}
