/**
 * Wayfinder orchestration — chart a map, claim tickets on the frontier, close out.
 *
 * The fs model lives in map.ts; this module is the workflow layer:
 *  - chartMap: scaffold a new effort (map.md + tickets dir) from a destination.
 *  - claimNextTicket: take the first frontier ticket, stamp a claim, return it.
 *
 * Like the grill commands, the substantive interview/synthesis is delegated to
 * the agent; these functions provide the on-disk scaffolding the agent operates
 * against. (resolveTicket/addTicket moved to tests/helpers/effort-fixtures.ts —
 * test-only, no production callers; statusReport/renderStatus were DELETED —
 * the ONE status pipeline is effort-tool.ts effortStatus + effort-render.ts
 * renderStatus, shared by /wayfind status and the wayfind_effort tool.)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeEffort } from "./lifecycle.js";
import { readMap, writeFreshMap, writeMap, writeTicket } from "./map.js";
import { computeFrontier, type Ticket, today, type WayfindMap } from "./model.js";
import { readStaleDecisions } from "./stale-seam.js";

/** Slugify a free-text destination/effort name: lowercase, hyphenate, trim,
 *  then truncate to ≤48 chars at a WORD BOUNDARY.
 *
 *  Truncation cuts at the last `-` at or before index 48 (never mid-word) and
 *  re-trims any trailing dash the cut leaves behind — failure memory #444: a
 *  naive `.slice(0, 48)` shipped mid-word fragments ("...theta-io") and
 *  dangling tails ("...-prevous-wayfind-"). When the first 48 chars contain no
 *  `-` (a single long word), there's no boundary to back up to, so the hard
 *  cut stands. Locked by `tests/slug.test.ts`. */
export function slugify(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 48) {
    s = s.slice(0, 48);
    const lastDash = s.lastIndexOf("-");
    if (lastDash > 0) s = s.slice(0, lastDash);
    s = s.replace(/-+$/g, ""); // re-trim a trailing dash the boundary cut exposed
  }
  return s || "effort";
}

/** Effort id for a free-text destination: `YYYY-MM-DD-<slug>` (the unified
 *  .planning/ convention; the date prefix is `today()` from model.ts so the
 *  effort folder prefix and the manifest `created` share ONE source and can
 *  never disagree across the UTC boundary). Use this for effort folder names;
 *  use `slugify` (bare) for ticket slugs, which carry their own NN- prefix.
 *  `now` is injectable for deterministic boundary tests (defaults to the wall
 *  clock). */
export function effortSlug(text: string, now: Date = new Date()): string {
  return `${today(now)}-${slugify(text)}`;
}

/** Scaffold a new effort: write map.md + create the tickets dir. Idempotent —
 *  re-running on an existing effort just rewrites map.md (preserves its
 *  decisions + tickets + manifest, including legacy prose-only maps whose
 *  meta=null keeps writeMap front-matter-free/byte-compatible). Fresh efforts
 *  go through the ONE constructor, writeFreshMap (W3 unification).
 *  Returns the freshly-written map (with whatever tickets already exist). */
export function chartMap(
  cwd: string,
  effort: string,
  destination: string,
  notes = "",
  now: Date = new Date(),
): WayfindMap {
  const existing = readMap(cwd, effort);
  if (!existing) return writeFreshMap(cwd, effort, destination, notes, undefined, now);
  const map: WayfindMap = {
    effort,
    destination: destination.trim(),
    notes: notes.trim(),
    decisions: existing.decisions,
    fog: [],
    outOfScope: [],
    tickets: existing.tickets,
    meta: existing.meta,
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

// ─── closing ceremony: /wayfind done ────────────────────────────────────────
// Distilled from the old "before goal_complete: write output/next-goal-*"
// global-memory entry into a structural pure function (decision 01: passive +
// auto-tidy). The MECHANICAL parts (completion check, timestamp filename,
// harvest from fog, file write) live here; the REFLECTIVE parts (false
// premises / footguns) stay with the agent — this writes a template the agent
// fills. The command handler runs tidy + notifies; this function does not.

/** Local timestamp as YYYYMMDD_HHMMSS (the canonical next-goal filename stamp). */
function nextGoalTimestamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = now;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Canonical `output/next-goal-*.md` filename matcher: `next-goal-` + the
 *  YYYYMMDD_HHMMSS stamp from {@link nextGoalTimestamp} + `.md`. Shared (single
 *  source of truth) with `tidy-next-goals.ts`, which uses it to detect
 *  already-normalized names instead of re-deriving the format. */
export const NEXT_GOAL_FILENAME_RE = /^next-goal-[0-9]{8}_[0-9]{6}\.md$/;

export interface CloseEffortReflection {
  /** Repo-relative path written, e.g. "output/next-goal-20260723_033000.md". */
  path: string;
  /** Recommended next goal (= first fog bullet), or a fallback when fog is empty. */
  nextGoal: string;
  /** Harvested deferred prizes (the map's "Not yet specified" bullets). */
  deferredPrizes: string[];
  effort: string;
  /** Where the effort was filed (`.planning/done/<effort>`), per D1. Undefined
   *  when the status+move filing failed — see `fileError`. */
  filedTo?: string;
  /** Present when the filing (status write + move to done/) failed; the next-goal
   *  note was still written. Surface in the /wayfind done notify. */
  fileError?: string;
}

export interface CloseEffortRefused {
  refused: string;
}

/** Closing ceremony for a completed effort: harvest its map into an
 *  `output/next-goal-<ts>.md` self-reflect note. Returns `{ refused }` unless
 *  the frontier is clear (no open unblocked tickets) — close them first.
 *
 *  10-impl (staleness dependency graph): the ceremony is now a GRADUATION GATE.
 *  After the frontier-check refused arm + before the graduation tail, a stale
 *  arm refuses while any closed decision whose cited/declared source-file deps
 *  changed since last validation remains. The fn is async because staleness is
 *  computed from the DB + source files at call time (the T7 seam reader). Null-
 *  safe: `readStaleDecisions` returns null when hermes is absent OR the seam
 *  throws → the gate degrades to a no-op (graduates, never crashes). */
export async function closeEffortReflection(
  cwd: string,
  effort: string,
  now: Date = new Date(),
): Promise<CloseEffortReflection | CloseEffortRefused> {
  const map = readMap(cwd, effort);
  if (!map) return { refused: `no map found for effort "${effort}" under .planning/` };
  const frontier = computeFrontier(map.tickets);
  if (frontier.length > 0) {
    const ids = frontier.map((t) => `${t.id} ${t.title}`).join("; ");
    return {
      refused: `${frontier.length} open ticket(s) remain on "${effort}" (${ids}); resolve them (or /wayfind sync) before /wayfind done`,
    };
  }
  // 10-impl (staleness dependency graph): BLOCK graduation while closed decisions
  // whose cited/declared source-file deps changed since last validation remain.
  // readStaleDecisions returns null when hermes-memory is absent → the gate is a
  // no-op (degrades, never crashes). Async because staleness is computed from
  // the DB + source files at call time (on-access, per ticket-10 Resolution γ).
  const stale = await readStaleDecisions(effort, cwd);
  if (stale && stale.length > 0) {
    const which = stale.map((s) => s.cardId).join(", ");
    return {
      refused: `${stale.length} stale decision(s) remain on "${effort}" — dependencies changed since last validation (${which}). Re-grill to resolve (re-open ticket, re-validate, update resolution) before /wayfind done`,
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

  const filing = fileCompletedEffort(cwd, effort);
  return { path: `output/${filename}`, nextGoal, deferredPrizes, effort, ...filing };
}

/** D1 canonical close as the tail of the ceremony: after the next-goal note is
 *  written, stamp `status: complete` + file the effort into `.planning/done/`.
 *  Returns the filing outcome (filedTo on success, fileError on failure). */
function fileCompletedEffort(cwd: string, effort: string): { filedTo?: string; fileError?: string } {
  const c = completeEffort(cwd, effort);
  return c.ok ? { filedTo: c.movedTo } : { fileError: c.reason };
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

_(Present this fork via the **ask_user_question tool** — recommended option (⭐) above; alternatives = the other deferred prizes + a fresh effort. Never a prose menu.)_
`;
}
