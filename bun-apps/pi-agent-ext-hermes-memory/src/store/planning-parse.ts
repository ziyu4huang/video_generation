// src/store/planning-parse.ts — pure helpers to parse .planning md into
// planning-card fields. Self-contained (no wayfind import): the .planning md
// format is the contract, mirroring KnowledgeSerializer's self-contained
// vault-md parsing. Parity with wayfind parseTicketFile/readMap is by format.
// The fence split delegates to the one leaf (frontmatter-codec.ts, C1 #1196);
// the alias export keeps the historical name for callers/tests.
export { splitFencedYaml as splitPlanningFrontmatter } from "./frontmatter-codec.js";

/** First H1 line (`# title`), or undefined. */
export function extractTitle(body: string): string | undefined {
  const m = body.match(/^# (.+)$/m);
  return m ? m[1]!.trim() : undefined;
}

/** One-line gist of a ticket's `## Resolution` section: the first non-empty
 *  line, truncated to 200 chars. Matches a `## Resolution` header with optional
 *  trailing suffix (e.g. `## Resolution (2026-08-09, grilled)`). Undefined when
 *  absent/empty. Deterministic — used for query/conflict (ticket 08 Q4). */
export function extractResolutionGist(body: string): string | undefined {
  const lines = body.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Resolution\b/.test(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  const section = out.join("\n").trim();
  if (!section) return undefined;
  const firstLine = section
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return undefined;
  return firstLine.length > 200 ? firstLine.slice(0, 197) + "..." : firstLine;
}

/** Normalise a frontmatter `blocked by` value (string | string[] | number) → string[].
 *
 *  ADAPTATION (08-impl T2→T3): YAML parses unquoted bare numbers — the wayfind
 *  `blocked by:` convention (e.g. `blocked by: 01`) — as NUMBERS, not strings
 *  (eemeli/yaml core schema → `1`, dropping the leading zero). Recover the
 *  canonical 2-digit zero-padded ticket number so the result matches the
 *  `NN-slug.md` filename convention the planning id scheme keys on
 *  (`planningTicketId(effort, "01")`). The plan's verbatim helper only handled
 *  string|string[] and returned [] for the number, failing the plan's own
 *  serializer test (frontmatter.blockedBy / blocked-by relation). */
export function parseBlockedBy(raw: unknown): string[] {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return [String(Math.trunc(raw)).padStart(2, "0")];
  }
  if (typeof raw === "string") return raw.split(/[,\s]+/).filter((s) => s.length > 0);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

/** Normalise a frontmatter `depends_on` value (string | string[]) → string[] of
 *  repo-relative PATHS (10-impl staleness dependency graph). Mirrors
 *  {@link parseBlockedBy} in SHAPE but NOT in semantics: these are file paths,
 *  NOT ticket numbers, so there is NO number-coercion and NO zero-pad. A string
 *  is split on commas/newlines (a single path stays whole); entries are trimmed
 *  and empties dropped. Wrong types → []. */
export function parseDependsOn(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/** Repo-relative source paths cited in a body (Resolution/Notes), for the
 *  staleness dependency graph (ticket 10). Matches rooted paths under
 *  bun-apps/, src/, python/, scripts/, docs/, tests/, .planning/. Deduped.
 *
 *  ADAPTATION (08-impl T2): the path body is `[A-Za-z0-9_./-]*[A-Za-z0-9_/-]` —
 *  it must END in a non-dot path char, so a trailing sentence period (e.g.
 *  `…phase2-design.md.` / `…card-store.ts.`) is NOT absorbed. The plan's
 *  verbatim `[A-Za-z0-9_./-]+` greedily ate that period and failed the plan's
 *  own dedupe test (extracted `….md.` ≠ expected `….md`). */
const CITED_PATH_RE = /((?:bun-apps|src|python|scripts|docs|tests|\.planning)\/[A-Za-z0-9_./-]*[A-Za-z0-9_/-])/g;
export function extractCitedPaths(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(CITED_PATH_RE)) {
    const path = m[1]!.trim();
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}
