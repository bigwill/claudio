/**
 * The band's tools (plan §4): a fixed list per role, every tool strict (every
 * field required, no min/max) and every tool with a `say` — the one line the
 * musician posts in the chat, threaded under your note.
 */
import type Anthropic from "@anthropic-ai/sdk";

import { PRESET_JSON_SCHEMA } from "../../src/shared/preset";
import type { BandRole } from "../../src/shared/pattern";

const say = { type: "string", description: "One short line to the producer about what you did. It appears in the band chat." } as const;
const lengthBars = { type: "integer", enum: [1, 2, 4], description: "Part length in bars; it repeats." } as const;

const tool = (name: string, description: string, properties: Record<string, unknown>): Anthropic.Tool => ({
  name,
  description,
  strict: true,
  input_schema: { type: "object", additionalProperties: false, required: Object.keys(properties), properties } as Anthropic.Tool.InputSchema,
});

const SET_PATTERN = tool("set_pattern", "Replace your part. It lands at the next bar line while the band keeps playing.", {
  say,
  lengthBars,
  notes: {
    type: "array",
    description: "Your notes. Empty means you lay out.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["step", "deg", "len", "vel", "accent"],
      properties: {
        step: { type: "integer", description: "Sixteenth step within the part, 0 to lengthBars*16-1" },
        deg: { type: "integer", description: "Chord-relative scale degree: 0 root, 2 third, 4 fifth, 7 root an octave up; negatives go down" },
        len: { type: "integer", description: "Length in sixteenth steps" },
        vel: { type: "number", description: "Velocity 0..1" },
        accent: { type: "boolean", description: "Accent: +0.25 velocity, for push" },
      },
    },
  },
});

const SET_DRUM_PATTERN = tool("set_drum_pattern", "Replace your drum part. It lands at the next bar line while the band keeps playing.", {
  say,
  lengthBars,
  hits: {
    type: "array",
    description: "Your hits. At most one of hat or openhat on a step (they share a cymbal). Empty means you lay out.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["step", "voice", "vel", "accent"],
      properties: {
        step: { type: "integer", description: "Sixteenth step within the part, 0 to lengthBars*16-1" },
        voice: { type: "string", enum: ["kick", "snare", "hat", "openhat"] },
        vel: { type: "number", description: "Velocity 0..1" },
        accent: { type: "boolean", description: "Accent: +0.25 velocity" },
      },
    },
  },
});

const SET_SOUND = tool(
  "set_sound",
  "Change your instrument's sound: a full FM preset (start from your current one in the snapshot and change the fields that matter). It lands at the next bar line and joins the shared library as a tweak.",
  { say, preset: PRESET_JSON_SCHEMA },
);
const USE_LIBRARY_SOUND = tool("use_library_sound", "Switch to a sound from your library, by its exact name as listed in the snapshot.", {
  say,
  name: { type: "string", description: "The library sound's name" },
});
const JUST_REPLY = tool("just_reply", "Answer without changing anything. Never use this for a note about your part or sound.", { say });
const STAY = tool("stay", "Keep your part as it is (e.g. a bandmate changed and yours still fits). Prefer this unless there's a clash.", { say });

export function toolsFor(role: BandRole): Anthropic.Tool[] {
  return role === "drums" ? [SET_DRUM_PATTERN, JUST_REPLY, STAY] : [SET_PATTERN, SET_SOUND, USE_LIBRARY_SOUND, JUST_REPLY, STAY];
}
