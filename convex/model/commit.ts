/**
 * planCommit: turn a band turn's tool calls into at most ONE change (plan §4
 * commit steps 3–5). Pure. Validates every call and never throws: an invalid
 * call becomes an is_error tool_result, and its reason is kept for the
 * failure copy. Every tool_use gets exactly one tool_result, in order.
 */
import type Anthropic from "@anthropic-ai/sdk";

import { clampPattern, STEPS_PER_BAR, type BandRole, type LengthBars, type Pattern } from "../../src/shared/pattern";
import { clampPreset, type ClaudioPreset } from "../../src/shared/preset";
import { toolsFor } from "./bandTools";

export interface CommitInput {
  role: BandRole;
  calls: Array<{ id: string; name: string; input: unknown }>;
  current: { lengthBars: LengthBars; notes: Pattern["notes"]; soundName: string | null; preset: ClaudioPreset | null };
  /** This role's library, for use_library_sound. */
  library: Array<{ id: string; name: string }>;
}

export type SoundChange = { kind: "tweak"; preset: ClaudioPreset } | { kind: "library"; libraryId: string; name: string };

export interface CommitPlan {
  part: Pattern | null;
  sound: SoundChange | null;
  says: string[];
  results: Anthropic.ToolResultBlockParam[];
  /** Why calls were rejected, for the chat's failure copy. */
  errors: string[];
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});

export function planCommit({ role, calls, current, library }: CommitInput): CommitPlan {
  const allowed = new Set(toolsFor(role).map((t) => t.name));
  const plan: CommitPlan = { part: null, sound: null, says: [], results: [], errors: [] };
  const ok = (id: string, content: string) => plan.results.push({ type: "tool_result", tool_use_id: id, content });
  const bad = (id: string, why: string) => {
    plan.results.push({ type: "tool_result", tool_use_id: id, content: why, is_error: true });
    plan.errors.push(why);
  };

  for (const call of calls) {
    const input = asObj(call.input);
    if (!allowed.has(call.name)) {
      bad(call.id, `${call.name} isn't one of ${role}'s tools`);
      continue;
    }
    const said = typeof input.say === "string" ? input.say.trim().slice(0, 280) : "";

    if (call.name === "set_pattern" || call.name === "set_drum_pattern") {
      const raw = call.name === "set_drum_pattern" ? { lengthBars: input.lengthBars, notes: input.hits } : input;
      const bars = [1, 2, 4].includes(Number(raw.lengthBars)) ? Number(raw.lengthBars) : null;
      const notes = Array.isArray(raw.notes) ? (raw.notes as Obj[]) : null;
      if (bars === null || notes === null) {
        bad(call.id, "lengthBars must be 1, 2 or 4, with a list of notes");
        continue;
      }
      const outside = notes.find((n) => Number(n.step) < 0 || Number(n.step) >= bars * STEPS_PER_BAR);
      if (outside) {
        bad(call.id, `step ${outside.step} is outside the ${bars}-bar part`);
        continue;
      }
      plan.part = clampPattern(role, { lengthBars: bars, notes });
      if (said) plan.says.push(said);
      ok(call.id, "Applied. It lands at the next bar line.");
    } else if (call.name === "set_sound") {
      if (typeof input.preset !== "object" || input.preset === null) {
        bad(call.id, "set_sound needs a full preset");
        continue;
      }
      const preset = clampPreset(input.preset);
      if (!asObj(input.preset).name) preset.name = `${current.soundName ?? "Sound"} tweak`;
      plan.sound = { kind: "tweak", preset };
      if (said) plan.says.push(said);
      ok(call.id, `Applied: ${preset.name}. It lands at the next bar line and is in the library now.`);
    } else if (call.name === "use_library_sound") {
      const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
      const hit = library.find((l) => l.name.toLowerCase() === name);
      if (!hit) {
        bad(call.id, `No sound called "${input.name}" in your library`);
        continue;
      }
      plan.sound = { kind: "library", libraryId: hit.id, name: hit.name };
      if (said) plan.says.push(said);
      ok(call.id, `Switched to ${hit.name}. It lands at the next bar line.`);
    } else {
      if (said) plan.says.push(said);
      ok(call.id, call.name === "stay" ? "Staying put." : "Noted.");
    }
  }
  return plan;
}
