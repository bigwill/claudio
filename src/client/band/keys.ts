/**
 * routeKey: the band's key router (plan §6). Pure, so the whole key map is unit
 * tested; the page listens on `window` in the capture phase, calls this, and
 * calls preventDefault for any non-null result (keydown AND keyup), so Space
 * never clicks a focused button and the page never scrolls.
 *
 * Rules: match `e.code` (layout-independent), but check `e.key === "?"` first
 * because `/` and `?` share Slash; null when meta, ctrl or alt is held; command
 * auto-repeat is swallowed; keyup always releases a note, in every mode.
 */

export type Strip = "you" | "drums" | "bass" | "keys";
export type Mode = "play" | "chat" | "picker";

export interface KeyInput {
  type: "keydown" | "keyup";
  code: string;
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat: boolean;
}

export type HistoryMove = { kind: "step"; dir: -1 | 1 } | { kind: "oldest" } | { kind: "newest" };

export type KeyAction =
  | { kind: "note-on"; code: string; degree: number }
  | { kind: "note-off"; code: string }
  | { kind: "swallow" }
  | { kind: "transport" }
  | { kind: "focus"; strip: Strip | null }
  | { kind: "octave"; delta: -1 | 1 }
  | { kind: "chat-open"; prefill: string }
  | { kind: "mode"; mode: Mode }
  | { kind: "history"; strip: Strip; move: HistoryMove }
  | { kind: "undo" }
  | { kind: "cancel"; strip: Strip }
  /** Ask the focused musician for a variation (Will, 2026-09-22). */
  | { kind: "vary"; strip: Exclude<Strip, "you"> }
  | { kind: "mute"; strip: Strip }
  | { kind: "solo"; strip: Strip }
  | { kind: "picker-open"; strip: Strip }
  | { kind: "picker-move"; delta: -1 | 1 }
  | { kind: "picker-choose" }
  | { kind: "scene-recall"; scene: "A" | "B" }
  | { kind: "scene-save"; scene: "A" | "B" }
  | { kind: "reacts-toggle" }
  | { kind: "bpm"; delta: -2 | 2 }
  | { kind: "overlay" }
  | { kind: "hint"; text: string };

const HOME = ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon"];
const TOP = ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP"];
const STRIPS: Record<string, Strip> = { Digit1: "you", Digit2: "drums", Digit3: "bass", Digit4: "keys" };
const NEEDS_STRIP = new Set(["ArrowLeft", "ArrowRight", "KeyM", "KeyN", "KeyB", "KeyC"]);
export const NO_STRIP_HINT = "press 1–4 to pick a strip";
export const VARY_HINT = "press 2–4 to pick a musician, then V";

/** Scale degree for a playing key (home row 0–9; top row the same an octave up), or null. */
export function degreeOf(code: string): number | null {
  const h = HOME.indexOf(code);
  if (h >= 0) return h;
  const t = TOP.indexOf(code);
  return t >= 0 ? t + 7 : null;
}

export function routeKey(e: KeyInput, mode: Mode, focus: Strip | null): KeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const degree = degreeOf(e.code);

  if (e.type === "keyup") {
    if (degree !== null) return { kind: "note-off", code: e.code };
    return mode === "play" && commandFor(e, focus) !== null ? { kind: "swallow" } : null;
  }

  if (mode === "chat") return e.code === "Escape" ? { kind: "mode", mode: "play" } : null;
  if (mode === "picker") {
    if (e.code === "ArrowUp") return { kind: "picker-move", delta: -1 };
    if (e.code === "ArrowDown") return { kind: "picker-move", delta: 1 };
    if (e.code === "Enter") return { kind: "picker-choose" };
    if (e.code === "Escape") return { kind: "mode", mode: "play" };
    return null;
  }

  if (degree !== null) return e.repeat ? { kind: "swallow" } : { kind: "note-on", code: e.code, degree };
  const command = commandFor(e, focus);
  if (command === null) return null;
  return e.repeat ? { kind: "swallow" } : command;
}

function commandFor(e: KeyInput, focus: Strip | null): KeyAction | null {
  if (e.key === "?") return { kind: "overlay" };
  if (STRIPS[e.code]) return { kind: "focus", strip: STRIPS[e.code] };
  if (NEEDS_STRIP.has(e.code) && focus === null) return { kind: "hint", text: NO_STRIP_HINT };
  if (e.code === "KeyV") return focus && focus !== "you" ? { kind: "vary", strip: focus } : { kind: "hint", text: VARY_HINT };
  switch (e.code) {
    case "Space":
      return { kind: "transport" };
    case "KeyZ":
      return { kind: "octave", delta: -1 };
    case "KeyX":
      return { kind: "octave", delta: 1 };
    case "Enter":
      return { kind: "chat-open", prefill: focus && focus !== "you" ? `@${focus} ` : "" };
    case "Slash":
      return { kind: "chat-open", prefill: focus && focus !== "you" ? `@${focus} ` : "" };
    case "Escape":
      return { kind: "focus", strip: null };
    case "ArrowLeft":
      return { kind: "history", strip: focus!, move: e.shiftKey ? { kind: "oldest" } : { kind: "step", dir: -1 } };
    case "ArrowRight":
      return { kind: "history", strip: focus!, move: e.shiftKey ? { kind: "newest" } : { kind: "step", dir: 1 } };
    case "Backspace":
      return { kind: "undo" };
    case "KeyC":
      return { kind: "cancel", strip: focus! };
    case "KeyM":
      return { kind: "mute", strip: focus! };
    case "KeyN":
      return { kind: "solo", strip: focus! };
    case "KeyB":
      return { kind: "picker-open", strip: focus! };
    case "BracketLeft":
      return e.shiftKey ? { kind: "scene-save", scene: "A" } : { kind: "scene-recall", scene: "A" };
    case "BracketRight":
      return e.shiftKey ? { kind: "scene-save", scene: "B" } : { kind: "scene-recall", scene: "B" };
    case "Backslash":
      return { kind: "reacts-toggle" };
    case "Comma":
      return { kind: "bpm", delta: -2 };
    case "Period":
      return { kind: "bpm", delta: 2 };
    default:
      return null;
  }
}
