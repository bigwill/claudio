/**
 * routeKey: the pure key router (plan §6), including the unit half of S11b.
 */
import { describe, expect, test } from "vitest";

import { routeKey, type KeyInput } from "./keys";

const down = (code: string, over: Partial<KeyInput> = {}): KeyInput => ({
  type: "keydown",
  code,
  key: over.key ?? "",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  repeat: false,
  ...over,
});
const up = (code: string, over: Partial<KeyInput> = {}): KeyInput => ({ ...down(code, over), type: "keyup" });

describe("play mode", () => {
  test("home row plays degrees 0–9, top row the same degrees an octave up", () => {
    expect(routeKey(down("KeyA"), "play", null)).toEqual({ kind: "note-on", code: "KeyA", degree: 0 });
    expect(routeKey(down("Semicolon"), "play", null)).toEqual({ kind: "note-on", code: "Semicolon", degree: 9 });
    expect(routeKey(down("KeyQ"), "play", null)).toEqual({ kind: "note-on", code: "KeyQ", degree: 7 });
    expect(routeKey(down("KeyP"), "play", null)).toEqual({ kind: "note-on", code: "KeyP", degree: 16 });
  });

  test("keyup releases the note", () => {
    expect(routeKey(up("KeyA"), "play", null)).toEqual({ kind: "note-off", code: "KeyA" });
  });

  test("a held note key's auto-repeat does nothing", () => {
    expect(routeKey(down("KeyA", { repeat: true }), "play", null)).toEqual({ kind: "swallow" });
  });

  test("commands", () => {
    expect(routeKey(down("Space"), "play", null)).toEqual({ kind: "transport" });
    expect(routeKey(down("Digit1"), "play", null)).toEqual({ kind: "focus", strip: "you" });
    expect(routeKey(down("Digit4"), "play", null)).toEqual({ kind: "focus", strip: "keys" });
    expect(routeKey(down("KeyZ"), "play", null)).toEqual({ kind: "octave", delta: -1 });
    expect(routeKey(down("KeyX"), "play", null)).toEqual({ kind: "octave", delta: 1 });
    expect(routeKey(down("Enter"), "play", "bass")).toEqual({ kind: "chat-open", prefill: "@bass " });
    expect(routeKey(down("Slash", { key: "/" }), "play", null)).toEqual({ kind: "chat-open", prefill: "" });
    expect(routeKey(down("Escape"), "play", "bass")).toEqual({ kind: "focus", strip: null });
    expect(routeKey(down("BracketLeft"), "play", null)).toEqual({ kind: "scene-recall", scene: "A" });
    expect(routeKey(down("BracketRight"), "play", null)).toEqual({ kind: "scene-recall", scene: "B" });
    expect(routeKey(down("Backslash"), "play", null)).toEqual({ kind: "reacts-toggle" });
    expect(routeKey(down("Comma"), "play", null)).toEqual({ kind: "bpm", delta: -2 });
    expect(routeKey(down("Period"), "play", null)).toEqual({ kind: "bpm", delta: 2 });
    expect(routeKey(down("Backspace"), "play", null)).toEqual({ kind: "undo" });
  });

  test("S11b: `?` opens the overlay and `/` opens chat, though they share the Slash key", () => {
    expect(routeKey(down("Slash", { key: "?", shiftKey: true }), "play", null)).toEqual({ kind: "overlay" });
    expect(routeKey(down("Slash", { key: "/" }), "play", null)).toMatchObject({ kind: "chat-open" });
  });

  test("S11b: Shift+[ and Shift+] save scenes", () => {
    expect(routeKey(down("BracketLeft", { shiftKey: true }), "play", null)).toEqual({ kind: "scene-save", scene: "A" });
    expect(routeKey(down("BracketRight", { shiftKey: true }), "play", null)).toEqual({ kind: "scene-save", scene: "B" });
  });

  test("S11b: modifier keys do nothing", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
      expect(routeKey(down("KeyA", { [mod]: true }), "play", null)).toBeNull();
      expect(routeKey(down("Space", { [mod]: true }), "play", null)).toBeNull();
    }
  });

  test("S11b: a held arrow takes one step (repeat is ignored for commands)", () => {
    expect(routeKey(down("ArrowLeft"), "play", "bass")).toEqual({ kind: "history", strip: "bass", move: { kind: "step", dir: -1 } });
    expect(routeKey(down("ArrowLeft", { repeat: true }), "play", "bass")).toEqual({ kind: "swallow" });
  });

  test("Shift+arrows jump to the oldest and newest version", () => {
    expect(routeKey(down("ArrowLeft", { shiftKey: true }), "play", "keys")).toEqual({ kind: "history", strip: "keys", move: { kind: "oldest" } });
    expect(routeKey(down("ArrowRight", { shiftKey: true }), "play", "keys")).toEqual({ kind: "history", strip: "keys", move: { kind: "newest" } });
  });

  test("strip commands with no strip focused only hint", () => {
    for (const code of ["ArrowLeft", "ArrowRight", "KeyM", "KeyN", "KeyB", "KeyC"]) {
      expect(routeKey(down(code), "play", null)).toEqual({ kind: "hint", text: "press 1–4 to pick a strip" });
    }
  });

  test("mute, solo, picker and cancel act on the focused strip", () => {
    expect(routeKey(down("KeyM"), "play", "drums")).toEqual({ kind: "mute", strip: "drums" });
    expect(routeKey(down("KeyN"), "play", "drums")).toEqual({ kind: "solo", strip: "drums" });
    expect(routeKey(down("KeyB"), "play", "bass")).toEqual({ kind: "picker-open", strip: "bass" });
    expect(routeKey(down("KeyC"), "play", "bass")).toEqual({ kind: "cancel", strip: "bass" });
  });

  test("V asks the focused musician for a variation; with no band strip focused, it hints", () => {
    expect(routeKey(down("KeyV"), "play", "bass")).toEqual({ kind: "vary", strip: "bass" });
    expect(routeKey(down("KeyV"), "play", "drums")).toEqual({ kind: "vary", strip: "drums" });
    expect(routeKey(down("KeyV"), "play", null)).toEqual({ kind: "hint", text: "press 2–4 to pick a musician, then V" });
    expect(routeKey(down("KeyV"), "play", "you")).toEqual({ kind: "hint", text: "press 2–4 to pick a musician, then V" });
  });

  test("keyups of command keys are swallowed so Space never clicks a focused button", () => {
    expect(routeKey(up("Space"), "play", null)).toEqual({ kind: "swallow" });
    expect(routeKey(up("ArrowLeft"), "play", "bass")).toEqual({ kind: "swallow" });
  });

  test("unhandled keys are left alone", () => {
    expect(routeKey(down("F5"), "play", null)).toBeNull();
  });
});

describe("chat mode", () => {
  test("every key types (Enter included: it sends, and chat stays open)", () => {
    expect(routeKey(down("KeyA"), "chat", "bass")).toBeNull();
    expect(routeKey(down("Space"), "chat", "bass")).toBeNull();
    expect(routeKey(down("Enter"), "chat", "bass")).toBeNull();
  });

  test("Esc leaves chat", () => {
    expect(routeKey(down("Escape"), "chat", "bass")).toEqual({ kind: "mode", mode: "play" });
  });

  test("S11b: keyup still releases a note held from before", () => {
    expect(routeKey(up("KeyA"), "chat", "bass")).toEqual({ kind: "note-off", code: "KeyA" });
  });
});

describe("picker mode", () => {
  test("arrows move, Enter picks, Esc closes; nothing else", () => {
    expect(routeKey(down("ArrowUp"), "picker", "bass")).toEqual({ kind: "picker-move", delta: -1 });
    expect(routeKey(down("ArrowDown"), "picker", "bass")).toEqual({ kind: "picker-move", delta: 1 });
    expect(routeKey(down("Enter"), "picker", "bass")).toEqual({ kind: "picker-choose" });
    expect(routeKey(down("Escape"), "picker", "bass")).toEqual({ kind: "mode", mode: "play" });
    expect(routeKey(down("KeyA"), "picker", "bass")).toBeNull();
  });
});
