import { expect, test } from "vitest";

import { SYSTEM_BLOCKS, TOOLS } from "./prompt";
import { reorderCalls, reorderSchema, stripRule10 } from "./spikes";

test("condition B removes rule 10 and nothing else", () => {
  const all = SYSTEM_BLOCKS.map((b) => b.text).join("\n");
  const stripped = SYSTEM_BLOCKS.map((b) => stripRule10(b.text)).join("\n");
  expect(all).toContain("10. SEVERAL PEOPLE");
  expect(stripped).not.toContain("SEVERAL PEOPLE");
  expect(stripped).toContain("9. Keep prose short.");
  expect(all.length - stripped.length).toBeLessThan(600);
});

test("condition C puts rationale first and the preset name last, in schema and replayed calls", () => {
  const tool = reorderSchema(TOOLS.find((t) => t.name === "propose_preset") as unknown as Record<string, unknown>) as {
    input_schema: { properties: Record<string, { properties?: Record<string, unknown>; required?: string[] }>; required: string[] };
  };
  expect(Object.keys(tool.input_schema.properties)).toEqual(["rationale", "preset"]);
  expect(tool.input_schema.required).toEqual(["rationale", "preset"]);
  const preset = tool.input_schema.properties.preset;
  expect(Object.keys(preset.properties!).at(-1)).toBe("name");
  expect(preset.required!.at(-1)).toBe("name");
  const [m] = reorderCalls([
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "propose_preset", input: { preset: { name: "n", harmonicity: 1 }, rationale: "r" } }] },
  ]);
  const input = (m.content as Array<{ input: { preset: object } }>)[0].input;
  expect(Object.keys(input)).toEqual(["rationale", "preset"]);
  expect(Object.keys(input.preset)).toEqual(["harmonicity", "name"]);
});
