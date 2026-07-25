/**
 * Wayfinder map + ticket data model — local-markdown store under
 * `.planning/<effort>/`.
 *
 *   map.md            — the index (Destination / Notes / Decisions so far /
 *                       Not yet specified / Out of scope)
 *   tickets/NN-slug.md — one decision ticket (YAML frontmatter + ## Question)
 *
 * Pure parsers (parseMapBody / parseTicketFile / computeFrontier) are split out
 * from the fs ops (readMap / writeMap) so the frontier + parse logic is unit-
 * testable without touching disk.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export interface WayfindMap {
  effort: string;
  destination: string;
  notes: string;
  decisions: MapDecision[];
  /** Fog of war — "Not yet specified". */
  fog: string[];
  outOfScope: string[];
  tickets: Ticket[];
}

// ─── pure parsers ───────────────────────────────────────────────────────────

/** Parse a `## Section`-delimited body into a map of section→text. Sections
 *  without a heading (preamble) land under key "". */
export function parseMapBody(md: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = md.split(/\r?\n/);
  let current = "";
  let buf: string[] = [];
  const flush = () => {
    sections[current] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      flush();
      // Lenient key: take the text before a ( / em-dash / en-dash / colon suffix
      // so `## Resolution (closed …)` / `## Section — desc` / `## Notes: x`
      // key as "Resolution" / "Section" / "Notes" (hand-authored suffixed
      // headers otherwise silently break section/closure detection).
      current = m[1].split(/[(\u2014\u2013:]/)[0].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** Parse a decision index line: `- [title](link) — gist` → MapDecision. */
export function parseDecisionLine(line: string): MapDecision | null {
  const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—-]\s*(.+)$/);
  if (!m) return null;
  return { title: m[1].trim(), link: m[2].trim(), gist: m[3].trim() };
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
        blocking = val
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
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

// ─── fs ops ─────────────────────────────────────────────────────────────────

/** The canonical effort dir: `<cwd>/.planning/<effort>/`. */
export function effortDir(cwd: string, effort: string): string {
  return join(cwd, ".planning", effort);
}

export function readMap(cwd: string, effort: string): WayfindMap | null {
  const dir = effortDir(cwd, effort);
  const mapPath = join(dir, "map.md");
  if (!existsSync(mapPath)) return null;

  const sections = parseMapBody(readFileSync(mapPath, "utf-8"));
  const decisions = (sections["Decisions so far"] ?? "")
    .split(/\r?\n/)
    .map(parseDecisionLine)
    .filter((d): d is MapDecision => d !== null);
  const fog = (sections["Not yet specified"] ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
  const outOfScope = (sections["Out of scope"] ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);

  const ticketsDir = join(dir, "tickets");
  const tickets: Ticket[] = [];
  if (existsSync(ticketsDir)) {
    for (const file of readdirSync(ticketsDir).sort()) {
      const m = file.match(/^(\d+)-(.+)\.md$/);
      if (!m) continue;
      const content = readFileSync(join(ticketsDir, file), "utf-8");
      tickets.push(parseTicketFile(content, m[1], m[2]));
    }
  }

  return {
    effort,
    destination: sections.Destination ?? "",
    notes: sections.Notes ?? "",
    decisions,
    fog,
    outOfScope,
    tickets,
  };
}

/** Write a brand-new map (map.md + tickets dir). Used by chartMap. Does not
 *  overwrite tickets — use resolveTicket / writeTicket for those. */
export function writeMap(cwd: string, map: WayfindMap): void {
  const dir = effortDir(cwd, map.effort);
  mkdirSync(join(dir, "tickets"), { recursive: true });
  const lines = [
    `# Wayfinder map: ${map.effort}`,
    "",
    "## Destination",
    "",
    map.destination.trim(),
    "",
    "## Notes",
    "",
    map.notes.trim() || "_(none)_",
    "",
    "## Decisions so far",
    "",
    map.decisions.length > 0
      ? map.decisions.map((d) => `- [${d.title}](${d.link}) — ${d.gist}`).join("\n")
      : "<!-- none yet -->",
    "",
    "## Not yet specified",
    "",
    map.fog.length > 0 ? map.fog.map((f) => `- ${f}`).join("\n") : "<!-- none -->",
    "",
    "## Out of scope",
    "",
    map.outOfScope.length > 0 ? map.outOfScope.map((f) => `- ${f}`).join("\n") : "<!-- none -->",
    "",
  ];
  writeFileSync(join(dir, "map.md"), lines.join("\n"), "utf-8");
}

/** Write (create or update) a single ticket file. */
export function writeTicket(cwd: string, effort: string, t: Ticket): void {
  const dir = join(effortDir(cwd, effort), "tickets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${t.id}-${t.slug}.md`), serializeTicket(t), "utf-8");
}

/** Append a one-line pointer to the map's Decisions so far (used on resolve). */
export function appendDecision(cwd: string, effort: string, decision: MapDecision): void {
  const mapPath = join(effortDir(cwd, effort), "map.md");
  if (!existsSync(mapPath)) return;
  const existing = readFileSync(mapPath, "utf-8");
  const line = `- [${decision.title}](${decision.link}) — ${decision.gist}`;
  // Insert after the "## Decisions so far" heading's block.
  const updated = existing.replace(/(## Decisions so far\s*\n(?:.*\n)*?)(\n##\s|$)/, (_full, head, tail) => {
    const block = head as string;
    const blockTrimmed = block.replace(/\s+$/, "");
    return `${blockTrimmed}\n${line}\n${tail}`;
  });
  writeFileSync(mapPath, updated, "utf-8");
}

/** Close a ticket: set status "closed" + a resolution, then persist. Returns
 *  true when it changed the file, false when the ticket was already closed with
 *  the same resolution (idempotent — used by syncChainState's loop). */
export function closeTicket(cwd: string, effort: string, ticket: Ticket, resolution: string): boolean {
  if (ticket.status === "closed" && (ticket.resolution ?? "") === resolution) return false;
  writeTicket(cwd, effort, { ...ticket, status: "closed", resolution });
  return true;
}
