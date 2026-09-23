/**
 * The only module that talks to Convex (plan §7). Everything the band UI
 * reads is a reactive subscription; everything it writes is a mutation.
 */
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

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

/** Mutations throw ConvexError with a message meant for people; surface it. */
export function errorText(e: unknown): string {
  const data = (e as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  return e instanceof Error ? e.message.replace(/^.*Uncaught ConvexError: /s, "").split("\n")[0] : String(e);
}
