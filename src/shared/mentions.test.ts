import { expect, test } from "vitest";

import { parseMentions } from "./mentions";

const band = [
  { id: "m-you", name: "you", role: "producer", kind: "human" as const },
  { id: "m-d", name: "drums", role: "drums", kind: "agent" as const },
  { id: "m-b", name: "bass", role: "bass", kind: "agent" as const },
  { id: "m-k", name: "keys", role: "keys", kind: "agent" as const },
];

test("@name addresses that musician", () => {
  expect(parseMentions("@bass busier, eighth notes", band)).toEqual({ to: ["m-b"], all: false });
});

test("several mentions, case-insensitive, in band order, no duplicates", () => {
  expect(parseMentions("@Keys and @BASS, tighter @bass", band)).toEqual({ to: ["m-b", "m-k"], all: false });
});

test("@all, or no mention, addresses every agent (empty to[])", () => {
  expect(parseMentions("@all lay back", band)).toEqual({ to: [], all: true });
  expect(parseMentions("lay back", band)).toEqual({ to: [], all: true });
});

test("unknown mentions and the human are ignored; an email isn't a mention", () => {
  expect(parseMentions("@you @sax play mail@bass.com", band)).toEqual({ to: [], all: true });
});
