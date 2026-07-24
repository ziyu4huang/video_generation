/**
 * Wayfinder orchestration — chart a map, claim + resolve tickets on the frontier.
 *
 * The fs model lives in map.ts; this module is the workflow layer:
 *  - chartMap: scaffold a new effort (map.md + tickets dir) from a destination.
 *  - claimNextTicket: take the first frontier ticket, stamp a claim, return it.
 *  - resolveTicket: record a resolution, close the ticket, append to Decisions.
 *  - statusReport: a low-res summary (frontier + counts) for /wayfinder-status.
 *
 * Like the grill commands, the substantive interview/synthesis is delegated to
 * the agent; these functions provide the on-disk scaffolding the agent operates
 * against.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendDecision,
  computeFrontier,
  readMap,
  type Ticket,
  type WayfindMap,
  writeMap,
  writeTicket,
} from "./map.js";

/** Slugify a free-text destination/effort name: lowercase, hyphenate, trim. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "effort"
  );
}

/** Today's date as `YYYY-MM-DD` (local). Used to prefix effort ids so they sort
 *  chronologically under .planning/. */
function datePrefix(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Effort id for a free-text destination: `YYYY-MM-DD-<slug>` (the unified
 *  .planning/ convention). Use this for effort folder names; use `slugify`
 *  (bare) for ticket slugs, which carry their own NN- prefix. */
export function effortSlug(text: string): string {
  return `${datePrefix()}-${slugify(text)}`;
}

/** Next zero-padded ticket id for an effort (max existing + 1, or "01"). */
export function nextTicketId(tickets: Ticket[]): string {
  if (tickets.length === 0) return "01";
  const max = tickets.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  return String(max + 1).padStart(2, "0");
}

/** Scaffold a new effort: write map.md + create the tickets dir. Idempotent —
 *  re-running on an existing effort just rewrites map.md (preserves tickets).
 *  Returns the freshly-written map (with whatever tickets already exist). */
export function chartMap(cwd: string, effort: string, destination: string, notes = ""): WayfindMap {
  const existing = readMap(cwd, effort);
  const map: WayfindMap = {
    effort,
    destination: destination.trim(),
    notes: notes.trim(),
    decisions: existing?.decisions ?? [],
    fog: [],
    outOfScope: [],
    tickets: existing?.tickets ?? [],
  };
  writeMap(cwd, map);
  return map;
}

/** Claim the first frontier ticket (open + unblocked + unclaimed) for `claimLabel`.
 *  Returns the claimed ticket, or null if the frontier is empty. */
export function claimNextTicket(cwd: string, effort: string, claimLabel: string): Ticket | null {
  const map = readMap(cwd, effort);
  if (!map) return null;
  const frontier = computeFrontier(map.tickets);
  const next = frontier[0];
  if (!next) return null;
  next.claimed = claimLabel;
  writeTicket(cwd, effort, next);
  return next;
}

/** Resolve a ticket: record the resolution, close it, and append a one-line
 *  pointer to the map's Decisions so far. Returns the updated ticket, or null if
 *  the ticket id isn't found. */
export function resolveTicket(
  cwd: string,
  effort: string,
  ticketId: string,
  resolution: string,
  gist?: string,
): Ticket | null {
  const map = readMap(cwd, effort);
  if (!map) return null;
  const ticket = map.tickets.find((t) => t.id === ticketId);
  if (!ticket) return null;
  ticket.resolution = resolution.trim();
  ticket.status = "closed";
  ticket.claimed = undefined;
  writeTicket(cwd, effort, ticket);
  appendDecision(cwd, effort, {
    title: ticket.title,
    link: `tickets/${ticket.id}-${ticket.slug}.md`,
    gist: (gist ?? resolution).split(/\r?\n/)[0].slice(0, 120),
  });
  return ticket;
}

/** Add a new ticket to an effort (create-then-wire). Returns the new ticket. */
export function addTicket(
  cwd: string,
  effort: string,
  title: string,
  question: string,
  type: Ticket["type"] = "grilling",
  blocking: string[] = [],
): Ticket {
  const map = readMap(cwd, effort);
  const id = nextTicketId(map?.tickets ?? []);
  const slug = slugify(title);
  const ticket: Ticket = { id, slug, title, question, type, blocking, status: "open" };
  writeTicket(cwd, effort, ticket);
  return ticket;
}

export interface StatusReport {
  effort: string;
  destination: string;
  open: number;
  closed: number;
  claimed: number;
  frontier: Ticket[];
  fog: number;
}

/** A low-res summary of an effort for /wayfinder-status. */
export function statusReport(cwd: string, effort: string): StatusReport | null {
  const map = readMap(cwd, effort);
  if (!map) return null;
  const open = map.tickets.filter((t) => t.status === "open");
  const closed = map.tickets.filter((t) => t.status === "closed");
  const claimed = open.filter((t) => t.claimed);
  return {
    effort: map.effort,
    destination: map.destination,
    open: open.length,
    closed: closed.length,
    claimed: claimed.length,
    frontier: computeFrontier(map.tickets),
    fog: map.fog.length,
  };
}

/** Render a StatusReport as a readable multi-line string for ctx.ui.notify. */
export function renderStatus(r: StatusReport): string {
  const lines = [
    `[${r.effort}] open ${r.open} · closed ${r.closed} · claimed ${r.claimed} · fog ${r.fog}`,
    `destination: ${r.destination || "(unset)"}`,
  ];
  if (r.frontier.length > 0) {
    lines.push("frontier:");
    for (const t of r.frontier) {
      lines.push(`  ${t.id} ${t.title} [${t.type}]`);
    }
  } else if (r.open > 0) {
    lines.push("frontier: (empty — all open tickets are blocked or claimed)");
  } else {
    lines.push("frontier: (clear — no open tickets; the way is found)");
    if (r.closed > 0) {
      lines.push("  → run `/wayfind done` for the closing ceremony (self-reflect + next-goal note)");
    }
  }
  return lines.join("\n");
}

// ─── closing ceremony: /wayfind done ────────────────────────────────────────
// Distilled from the old "before goal_complete: write output/next-goal-*"
// global-memory entry into a structural pure function (decision 01: passive +
// auto-tidy). The MECHANICAL parts (completion check, timestamp filename,
// harvest from fog, file write) live here; the REFLECTIVE parts (false
// premises / footguns) stay with the agent — this writes a template the agent
// fills. The command handler runs tidy + notifies; this function does not.

/** Local timestamp as YYYYMMDD_HHMMSS (matches scripts/tidy-next-goals.sh). */
function nextGoalTimestamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = now;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface CloseEffortReflection {
  /** Repo-relative path written, e.g. "output/next-goal-20260723_033000.md". */
  path: string;
  /** Recommended next goal (= first fog bullet), or a fallback when fog is empty. */
  nextGoal: string;
  /** Harvested deferred prizes (the map's "Not yet specified" bullets). */
  deferredPrizes: string[];
  effort: string;
}

export interface CloseEffortRefused {
  refused: string;
}

/** Closing ceremony for a completed effort: harvest its map into an
 *  `output/next-goal-<ts>.md` self-reflect note. Returns `{ refused }` unless
 *  the frontier is clear (no open unblocked tickets) — close them first. */
export function closeEffortReflection(
  cwd: string,
  effort: string,
  now: Date = new Date(),
): CloseEffortReflection | CloseEffortRefused {
  const map = readMap(cwd, effort);
  if (!map) return { refused: `no map found for effort "${effort}" under .planning/` };
  const frontier = computeFrontier(map.tickets);
  if (frontier.length > 0) {
    const ids = frontier.map((t) => `${t.id} ${t.title}`).join("; ");
    return {
      refused: `${frontier.length} open ticket(s) remain on "${effort}" (${ids}); resolve them (or /wayfind sync) before /wayfind done`,
    };
  }
  const deferredPrizes = map.fog.filter((p) => !p.startsWith("<!--"));
  const nextGoal = deferredPrizes[0] ?? "(fog is empty — no deferred prizes harvested; pick the next goal freely)";

  const body = renderNextGoalNote({
    effort,
    destination: map.destination,
    deferredPrizes,
    nextGoal,
  });
  const filename = `next-goal-${nextGoalTimestamp(now)}.md`;
  mkdirSync(join(cwd, "output"), { recursive: true });
  writeFileSync(join(cwd, "output", filename), body, "utf-8");

  return { path: `output/${filename}`, nextGoal, deferredPrizes, effort };
}

function renderNextGoalNote(args: {
  effort: string;
  destination: string;
  deferredPrizes: string[];
  nextGoal: string;
}): string {
  const prizes =
    args.deferredPrizes.length > 0
      ? args.deferredPrizes.map((p, i) => `${i + 1}. ${p}`).join("\n")
      : "_(none harvested — fog was empty)_";
  return `# Goal completed: ${args.destination || args.effort}

Effort: \`.planning/${args.effort}/\`
Self-reflect + next-goal note written by \`/wayfind done\` (the closing ceremony, distilled from the convention into a command).

## Self-reflection — fill in (only the agent knows these)

### False premises / course-corrections
_(fill: hypotheses that were wrong, mental models that needed correcting)_

### Footguns
_(fill: non-obvious traps for future work in this area)_

## Deferred prizes (harvested from the map's "Not yet specified")

${prizes}

## Next concrete goal (recommended)

**${args.nextGoal}**

_(Confirm or replace — the first deferred prize above; pick a concrete, non-gated, non-conflicting next goal.)_
`;
}
