// src/store/planning-id.ts — canonical id scheme + file-path parsing for
// planning-cards (Phase-2 / ticket 08). Planning-cards share the unified
// `memories` table with memory/knowledge cards, so Card.id (= memories.md_id)
// MUST be globally unique. The `planning-effort:` / `planning-ticket:` prefixes
// guarantee no collision with memory (timestamp/hash) or knowledge (zettel) ids.

/** Discriminate a planning source file from repo-relative path segments.
 *  08 scope: `<effort>/map.md` → effort; `<effort>/tickets/NN-slug.md` → ticket.
 *  Everything else under .planning/ (specs/, plans/, flat files) is NOT a card. */
export function planningCardKindFromSegs(
  relSegs: string[],
): "planning-effort" | "planning-ticket" | null {
  const i = relSegs.indexOf(".planning");
  if (i < 0) return null;
  const after = relSegs.slice(i + 1);
  const n = after.length;
  if (n === 0) return null;
  const file = after[n - 1]!;
  // <effort>/tickets/NN-slug.md  (n >= 3: .planning / effort / tickets / file)
  if (n >= 3 && after[n - 2] === "tickets" && /^\d+-[^/]+\.md$/.test(file)) {
    return "planning-ticket";
  }
  // <effort>/map.md  (n === 2: .planning / effort / map.md)
  if (n === 2 && file === "map.md") return "planning-effort";
  return null;
}

/** Convenience: classify an absolute or relative md path (any separator). */
export function planningCardKindFromPath(
  filePath: string,
): "planning-effort" | "planning-ticket" | null {
  return planningCardKindFromSegs(filePath.split(/[\\/]/));
}

export interface PlanningPathInfo {
  kind: "planning-effort" | "planning-ticket";
  effort: string;
  ticketNo?: string;
  slug?: string;
}

/** Parse a planning source path → { kind, effort, ticketNo?, slug? }, or null. */
export function parsePlanningPath(filePath: string): PlanningPathInfo | null {
  const kind = planningCardKindFromPath(filePath);
  if (!kind) return null;
  const segs = filePath.split(/[\\/]/);
  const i = segs.indexOf(".planning");
  const after = segs.slice(i + 1);
  const effort = after[0]!;
  if (kind === "planning-effort") return { kind, effort };
  const file = after[after.length - 1]!;
  const m = /^(\d+)-(.+)\.md$/.exec(file);
  return { kind, effort, ticketNo: m![1]!, slug: m![2]! };
}

/** Canonical, globally-unique Card.id for a planning-effort card. */
export function planningEffortId(effort: string): string {
  return `planning-effort:${effort}`;
}

/** Canonical, globally-unique Card.id for a planning-ticket card. */
export function planningTicketId(effort: string, ticketNo: string): string {
  return `planning-ticket:${effort}:${ticketNo}`;
}
