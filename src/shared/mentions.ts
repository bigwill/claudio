/**
 * parseMentions: who a producer note is addressed to (plan §4 chat.send).
 * `@name` or `@role` picks agents; `@all` or no mention means every agent,
 * which chat stores as an empty `to[]`. The human is never addressed.
 */

export interface Addressable {
  id: string;
  name: string;
  role: string;
  kind: "agent" | "human";
}

export function parseMentions<T extends Addressable>(text: string, band: readonly T[]): { to: T["id"][]; all: boolean } {
  const words = new Set([...text.matchAll(/(?:^|[^\w@.])@([a-z]+)\b/gi)].map((m) => m[1].toLowerCase()));
  if (words.has("all")) return { to: [], all: true };
  const to = band
    .filter((m) => m.kind === "agent" && (words.has(m.name.toLowerCase()) || words.has(m.role.toLowerCase())))
    .map((m) => m.id);
  return to.length ? { to, all: false } : { to: [], all: true };
}
