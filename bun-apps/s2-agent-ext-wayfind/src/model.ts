/**
 * Wayfind map + ticket data model — fs-free foundation.
 *
 * Pure types, parsers, serializers, and path/date helpers for the
 * `.planning/<effort>/` local-markdown store. NO `node:fs` import: this module
 * is the testable core that both the store (map.ts) and the lifecycle ops
 * (lifecycle.ts) build on. (Split out of the former monolithic map.ts.)
 */

import { join } from "node:path";

import { parseMapBody } from "./markdown.js";

export type TicketType = "research" | "prototype" | "grilling" | "task";
export type TicketStatus = "open" | "closed";

export interface Ticket {
  /** Zero-padded number prefix from the filename, e.g. "01". */
  id: string;
  /** Slug from the filename (after NN-), e.g. "pick-storage". */
  slug: string;
  /** Human title (first H1 or the slug). */
  title: string;
  question: string;
  type: TicketType;
  /** Ticket ids that must close before this one can start. */
  blocking: string[];
  /** Claim label if a session has claimed it. */
  claimed?: string;
  status: TicketStatus;
  /** Resolution text, present when the ticket is closed. */
  resolution?: string;
  /** "What to build" body section (to-tickets' human field, folded into the
   *  unified ticket spine). Prose: the end-to-end behaviour this ticket makes work. */
  whatToBuild?: string;
  /** Acceptance criteria from the `## Acceptance` body section, as checkbox
   *  item texts (the `- [ ]` / `- [x]` markers stripped). */
  acceptance?: string[];
}

export interface MapDecision {
  title: string;
  gist: string;
  /** Relative link to the closed ticket, e.g. "tickets/01-pick-storage.md". */
  link: string;
}

export type EffortStatus = "active" | "complete" | "paused";

/**
 * Effort-level manifest metadata — the OPTIONAL YAML front-matter on `map.md`.
 * Mirrors the skill `name`/`description` + ticket `status` front-matter pattern
 * (the established ecosystem convention — obra/superpowers ships extractFrontmatter
 * and puts front-matter on docs/plans/*.md). All fields optional except `effort`
 * (which SHOULD match the folder slug). Absent front-matter on the ~377 legacy
 * prose-only efforts parses to `null` (backward-compat — never an error).
 */
export interface EffortMeta {
  effort: string;
  created?: string;
  last?: string;
  status?: EffortStatus;
  owner?: string;
}

export interface WayfindMap {
  effort: string;
  destination: string;
  notes: string;
  decisions: MapDecision[];
  /** Fog of war — "Not yet specified". */
  fog: string[];
  outOfScope: string[];
  tickets: Ticket[];
  /** Optional front-matter manifest; null/absent on legacy prose-only maps. */
  meta?: EffortMeta | null;
}

export type SetStatusResult = { ok: true } | { ok: false; reason: string };

export interface CompleteEffortResult {
  ok: boolean;
  effort: string;
  /** Repo-relative destination when ok, e.g. ".planning/done/<effort>". */
  movedTo?: string;
  /** Present when ok is false. */
  reason?: string;
}

// ─── pure parsers ───────────────────────────────────────────────────────────

const MAP_FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const EFFORT_STATUSES = new Set<EffortStatus>(["active", "complete", "paused"]);

/**
 * Parse an OPTIONAL leading YAML front-matter block from a `map.md` body.
 * Returns `{ meta: null, body: <unchanged> }` when there is no front-matter
 * (legacy maps) — never throws. Reuses the same fence shape as ticket
 * front-matter (parseTicketFile) for consistency.
 */
export function parseMapFrontmatter(md: string): { meta: EffortMeta | null; body: string } {
  const m = md.match(MAP_FM_RE);
  if (!m) return { meta: null, body: md };
  const raw = m[1] ?? "";
  const body = (m[2] ?? md).replace(/^\r?\n+/, "");
  let effort: string | undefined;
  let created: string | undefined;
  let last: string | undefined;
  let status: EffortStatus | undefined;
  let owner: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === "effort") effort = val || undefined;
    else if (key === "created") created = val || undefined;
    else if (key === "last") last = val || undefined;
    else if (key === "status") status = EFFORT_STATUSES.has(val as EffortStatus) ? (val as EffortStatus) : undefined;
    else if (key === "owner") owner = val || undefined;
  }
  // A front-matter block without `effort` isn't a manifest — treat as none.
  if (!effort) return { meta: null, body };
  return { meta: { effort, created, last, status, owner }, body };
}

/** Parse a decision index line: `- [title](link) — gist` → MapDecision. */
export function parseDecisionLine(line: string): MapDecision | null {
  const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—-]\s*(.+)$/);
  if (!m) return null;
  return { title: m[1].trim(), link: m[2].trim(), gist: m[3].trim() };
}

/** Parse a simple `- item` bullet list section into trimmed strings.
 *  HTML-comment placeholders (e.g. the `<!-- none -->` marker writeMap emits
 *  for an empty fog / out-of-scope section) are dropped so they are not counted
 *  as real items on read-back — otherwise every fresh effort reports `fog 1`.
 *
 *  Exported (not module-private) because the store layer (`map.ts`'s `readMap`)
 *  consumes it — the only caller. Kept here as the single source of truth so the
 *  bullet-parse rule can never drift between the writer (map.ts) and the model. */
export function parseBulletList(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter((l) => l !== "" && !l.startsWith("<!--"));
}

/** Parse a ticket file's frontmatter + body into a Ticket. `id`/`slug` come from
 *  the filename, passed in. */
export function parseTicketFile(content: string, id: string, slug: string): Ticket {
  let type: TicketType = "grilling";
  let blocking: string[] = [];
  let claimed: string | undefined;
  let status: TicketStatus = "open";
  let resolution: string | undefined;
  let body = content;

  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    const raw = fm[1];
    body = fm[2];
    for (const line of raw.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const val = line
        .slice(idx + 1)
        .trim()
        .replace(/^\[|\]$/g, "");
      if (key === "type") type = (val as TicketType) || type;
      else if (key === "blocking" || key === "blocked_by" || key === "blocked by") {
        // Failure memory #471: validate each edge is a bare ticket number. The
        // parser used to silently coerce ANY value into blocking[] (a bracketed
        // slug like `blocking: ["01-foo"]` or a bare `blocking: abc` parsed to
        // `["01-foo"]` / `["abc"]`), quietly breaking the dependency graph —
        // computeFrontier never matches a closed id, so the edge just vanished.
        // Now strip per-entry quotes (so the bracketed form `blocking: ["01", "02"]`
        // is accepted alongside the bare form) and THROW on any non-numeric entry
        // — surfaced, never silent.
        blocking = val
          .split(/[,\s]+/)
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        for (const b of blocking) {
          if (!/^\d+$/.test(b)) {
            throw new Error(
              `ticket ${id}: invalid 'blocking' entry "${b}" — must be a bare ticket number ` +
                `(digits only), e.g. \`blocking: 01, 02\`.`,
            );
          }
        }
      } else if (key === "claimed") claimed = val || undefined;
      else if (key === "status") status = val === "closed" ? "closed" : "open";
    }
  }

  // Title = first H1; Question = the ## Question body; Resolution = ## Resolution body.
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : slug;
  const bodySections = parseMapBody(body);
  const question = bodySections.Question ?? body.trim();
  if (bodySections.Resolution) {
    resolution = bodySections.Resolution;
    status = "closed"; // a resolution block implies closed
  }
  const whatToBuild = bodySections["What to build"] || undefined;
  const acceptanceRaw = bodySections.Acceptance;
  const acceptance = acceptanceRaw
    ? acceptanceRaw
        .split(/\r?\n/)
        .map((line) => {
          const m = line.match(/^\s*-\s+\[[ xX]\]\s*(.+)$/);
          return m ? m[1].trim() : null;
        })
        .filter((s): s is string => s !== null)
    : undefined;
  return { id, slug, title, question, type, blocking, claimed, status, resolution, whatToBuild, acceptance };
}

// ─── serializers + logic ─────────────────────────────────────────────────────

/**
 * Serialize `EffortMeta` to a YAML front-matter block terminated by a blank
 * line. Only emits set fields; `effort` is always emitted (required).
 */
export function serializeMapFrontmatter(meta: EffortMeta): string {
  const lines = ["---", `effort: ${meta.effort}`];
  if (meta.created) lines.push(`created: ${meta.created}`);
  if (meta.last) lines.push(`last: ${meta.last}`);
  if (meta.status) lines.push(`status: ${meta.status}`);
  if (meta.owner) lines.push(`owner: ${meta.owner}`);
  lines.push("---", "");
  return `${lines.join("\n")}\n`;
}

/** Serialize a ticket back to its file form. */
export function serializeTicket(t: Ticket): string {
  const fm = [
    "---",
    `type: ${t.type}`,
    t.blocking.length > 0 ? `blocking: ${t.blocking.join(", ")}` : null,
    t.claimed ? `claimed: ${t.claimed}` : null,
    `status: ${t.status}`,
    "---",
    "",
  ]
    .filter((x) => x !== null)
    .join("\n");
  const lines = [fm, `# ${t.title}`, "", "## Question", "", t.question.trim()];
  if (t.whatToBuild) {
    lines.push("", "## What to build", "", t.whatToBuild.trim());
  }
  if (t.acceptance && t.acceptance.length > 0) {
    lines.push("", "## Acceptance", "", ...t.acceptance.map((c) => `- [ ] ${c}`));
  }
  if (t.resolution) {
    lines.push("", "## Resolution", "", t.resolution.trim());
  }
  return `${lines.join("\n")}\n`;
}

/** The frontier: open tickets whose blockers are all closed (or absent),
 *  and which are not yet claimed. Order = ascending id. */
export function computeFrontier(tickets: Ticket[]): Ticket[] {
  const closed = new Set(tickets.filter((t) => t.status === "closed").map((t) => t.id));
  return tickets
    .filter((t) => t.status === "open")
    .filter((t) => !t.claimed)
    .filter((t) => t.blocking.every((b) => closed.has(b)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Conformance check on a parsed `WayfindMap`. Surfaces the original failure
 * mode: a hand-written map with non-canonical sections parses to an empty
 * Destination SILENTLY. `folderEffort` (the dir slug) optionally checks the
 * front-matter `effort` matches the folder the map lives in.
 */
export function validateEffortMap(map: WayfindMap, folderEffort?: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!map.destination.trim()) {
    problems.push("missing required '## Destination' section (the map parsed no destination)");
  }
  if (map.meta) {
    if (!map.meta.effort) problems.push("front-matter present but `effort` field is empty");
    if (folderEffort && map.meta.effort && map.meta.effort !== folderEffort) {
      problems.push(`front-matter effort '${map.meta.effort}' ≠ folder effort '${folderEffort}'`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ─── pure helpers ────────────────────────────────────────────────────────────

/** Today's date as `YYYY-MM-DD` in LOCAL time — the ONE source of truth for
 *  every wayfind date stamp (effort folder prefix via effortSlug, manifest
 *  `created`, and the `last:` touch). Local — not UTC — so "today's effort"
 *  tracks the user's own day, and the folder name + manifest `created` (both
 *  derived from this) can never diverge across the UTC day boundary. `now` is
 *  injectable so boundary tests can pin the clock deterministically. */
export function today(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The canonical effort dir: `<cwd>/.planning/<effort>/`. */
export function effortDir(cwd: string, effort: string): string {
  return join(cwd, ".planning", effort);
}

/** The `done/` archive root: `<cwd>/.planning/done/`. */
export function doneDir(cwd: string): string {
  return join(cwd, ".planning", "done");
}
