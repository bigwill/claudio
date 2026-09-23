/**
 * routeNote: where a producer note goes (Will, 2026-09-22). Pure, shared by
 * chat.send (which decides, in one mutation) and the page (which shows the
 * same answer as a chip under the box before you press Enter).
 *
 * - "@keys design a glassy bell" → a measured design for that one pitched
 *   musician, with the rest as the prompt.
 * - "@me …" → a design of your own sound: nobody is there to tweak it.
 * - Anything else → a note to the musicians it names (none named = everyone),
 *   which is where quick tweaks ("glassier") happen, as a band turn.
 */

export interface Member {
  id: string;
  name: string;
  role: string;
  kind: "agent" | "human";
}

export type Route<Id extends string = string> =
  | { kind: "note"; to: Id[] }
  | { kind: "design"; musicianId: Id; prompt: string }
  | { kind: "refuse"; why: string };

const MENTION = /(?:^|[^\w@.])@([a-z]+)\b/gi;
const DESIGN = /^design\b[\s:,]*(.*)$/is;

export function routeNote<M extends Member>(text: string, band: readonly M[]): Route<M["id"]> {
  const words = new Set([...text.matchAll(MENTION)].map((m) => m[1].toLowerCase()));
  const rest = text
    .replace(MENTION, (m) => m.replace(/@[a-z]+/i, ""))
    .replace(/\s+/g, " ")
    .replace(/^[\s:,]+/, "")
    .trim();
  if (!rest) return { kind: "refuse", why: "Say something after the mention." };

  const all = words.has("all");
  const agents = band.filter((m) => m.kind === "agent" && (words.has(m.name.toLowerCase()) || words.has(m.role.toLowerCase())));
  const me = band.find((m) => m.kind === "human" && (words.has("me") || words.has("you")));
  const design = rest.match(DESIGN);

  if (me) {
    if (agents.length || all) return { kind: "refuse", why: "Design your own sound or talk to the band, not both at once." };
    const prompt = design ? design[1].trim() : rest;
    if (prompt.split(" ").length < 2) return { kind: "refuse", why: "Describe the sound you want, e.g. @me a warm pad with a slow attack." };
    return { kind: "design", musicianId: me.id, prompt };
  }

  if (design) {
    const prompt = design[1].trim();
    if (prompt.split(" ").filter(Boolean).length < 2) return { kind: "refuse", why: "Describe the sound, e.g. @keys design a glassy bell." };
    if (all || agents.length !== 1) return { kind: "refuse", why: "Design one musician's sound at a time, e.g. @keys design a glassy bell." };
    if (agents[0].role === "drums") return { kind: "refuse", why: "Drums play the kit; there's no sound to design." };
    return { kind: "design", musicianId: agents[0].id, prompt };
  }
  return { kind: "note", to: all ? [] : agents.map((m) => m.id) };
}
