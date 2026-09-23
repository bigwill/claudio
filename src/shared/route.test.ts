/**
 * routeNote: where a producer note goes (Will, 2026-09-22). The server routes
 * with it in chat.send; the page shows the same answer as a chip before Enter.
 */
import { expect, test } from "vitest";

import { routeNote } from "./route";

const band = [
  { id: "me", name: "you", role: "producer", kind: "human" as const },
  { id: "d", name: "drums", role: "drums", kind: "agent" as const },
  { id: "b", name: "bass", role: "bass", kind: "agent" as const },
  { id: "k", name: "keys", role: "keys", kind: "agent" as const },
];

test("a plain note goes to the musicians it names, or the whole band", () => {
  expect(routeNote("@bass busier, eighth notes", band)).toEqual({ kind: "note", to: ["b"] });
  expect(routeNote("everyone lay back", band)).toEqual({ kind: "note", to: [] });
  expect(routeNote("@all lay back", band)).toEqual({ kind: "note", to: [] });
});

test("\"design …\" to exactly one pitched musician starts a measured design with the rest as the prompt", () => {
  expect(routeNote("@keys design a glassy bell, quite short", band)).toEqual({
    kind: "design",
    musicianId: "k",
    prompt: "a glassy bell, quite short",
  });
  expect(routeNote("@Bass Design: a round sub", band)).toEqual({ kind: "design", musicianId: "b", prompt: "a round sub" });
});

test("design needs a real description: two words at least", () => {
  expect(routeNote("@keys design", band)).toMatchObject({ kind: "refuse" });
  expect(routeNote("@keys design pads", band)).toMatchObject({ kind: "refuse" });
});

test("\"design\" not leading the note is just a word in a note", () => {
  expect(routeNote("@keys I love that design", band)).toEqual({ kind: "note", to: ["k"] });
  expect(routeNote("@keys designer chords please", band)).toEqual({ kind: "note", to: ["k"] });
});

test("a design must name one pitched musician: not drums, not several, not the whole band", () => {
  expect(routeNote("@drums design a tight kit", band)).toEqual({ kind: "refuse", why: "Drums play the kit; there's no sound to design." });
  expect(routeNote("@bass @keys design a warm pad", band)).toMatchObject({ kind: "refuse" });
  expect(routeNote("design a warm pad", band)).toMatchObject({ kind: "refuse" });
  expect(routeNote("@all design a warm pad", band)).toMatchObject({ kind: "refuse" });
});

test("@me designs your own sound: there's no musician to tweak it, so any description designs", () => {
  expect(routeNote("@me a warm pad with a slow attack", band)).toEqual({
    kind: "design",
    musicianId: "me",
    prompt: "a warm pad with a slow attack",
  });
  expect(routeNote("@me design a warm pad", band)).toEqual({ kind: "design", musicianId: "me", prompt: "a warm pad" });
  expect(routeNote("@me", band)).toMatchObject({ kind: "refuse" });
  expect(routeNote("@me @bass a pad", band)).toMatchObject({ kind: "refuse" });
});

test("empty text is refused", () => {
  expect(routeNote("   ", band)).toMatchObject({ kind: "refuse" });
  expect(routeNote("@bass ", band)).toMatchObject({ kind: "refuse" });
});
