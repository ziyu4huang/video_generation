/**
 * Pure /wayfind helpers — effort-id resolution and the usage overview. Moved
 * verbatim from commands.ts (Task 9); they take cwd / active-effort inputs so
 * they stay unit-testable without a live session.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { listEfforts } from "../effort-query.js";
import { effortSlug } from "../wayfinder.js";
import { WAYFIND_KEYWORDS } from "./keywords.js";

/** Resolve the effort id in play for a `/wayfind <args>` invocation, so the
 *  dispatcher can banner it on EVERY run. Mirrors the dispatcher's own parsing
 *  (force-chart `--`, reserved-keyword subcommand, bare chart, no-arg claim) so
 *  the banner always matches the effort the subcommand operates on. Returns
 *  undefined only when no effort is in play yet (bare `/wayfind` with no active
 *  effort → a usage warning follows; no banner). Pure: takes the trimmed arg
 *  plus an active-effort lookup so it is unit-testable without a live session. */
export function resolveWayfindEffortId(trimmed: string, getActive: () => string | undefined): string | undefined {
  if (trimmed.startsWith("--")) {
    const destination = trimmed.slice(2).trim();
    return destination ? effortSlug(destination) : getActive();
  }
  const [first, ...rest] = trimmed.split(/\s+/);
  if (first && WAYFIND_KEYWORDS.has(first)) {
    return rest.join(" ").trim() || getActive();
  }
  if (trimmed) return effortSlug(trimmed);
  return getActive();
}

/** Render the full `/wayfind` usage overview: subcommand table, efforts on
 *  disk, and next steps. The on-disk section reuses {@link listEfforts} — the
 *  same read path bare-/wayfind adoption uses — ranked by map.md mtime,
 *  newest first (the same signal adoptMostRecentActiveEffort ranks by), capped
 *  at 10. Pure: takes cwd + the session's active effort slug (marked
 *  `(active)` in the listing) so it is unit-testable without a live session. */
export function renderWayfindHelp(cwd: string, activeEffort: string | undefined): string {
  const lines: string[] = [
    "🧭 wayfind — usage",
    "",
    "  /wayfind <destination>      chart a new effort: grill + map the frontier under .planning/<effort>/",
    "  /wayfind                    resume the active effort: claim + steer the next frontier ticket",
    "  /wayfind status [effort]    frontier + open/closed/claimed/fog counts (auto-closes completed plan phases)",
    "  /wayfind spec [effort]      steer: synthesize this conversation into .planning/<effort>/spec.md",
    "  /wayfind tickets [effort]   steer: break the spec into tracer-bullet tickets under .planning/<effort>/tickets/",
    "  /wayfind seed [effort]      flatten tickets/decisions into .planning/<effort>/task_plan.md (refuses to overwrite)",
    "  /wayfind sync [effort]      close tickets whose task_plan phase completed",
    "  /wayfind done [effort]      closing ceremony: harvest to output/next-goal-<ts>.md + archive to .planning/done/",
    "  /wayfind validate [effort]  check map/manifest/ticket conformance",
    "  /wayfind statusbar on|off   toggle the persistent effort status bar",
    "  /wayfind help               this overview (alias: usage)",
    "  /wayfind -- <destination>   force-chart a name that starts with a reserved keyword",
    "",
    "  [effort]: explicit id, else the session's active effort (status, seed, sync, done, validate);",
    "  spec/tickets use it only to name the output dir.",
    "",
    "Efforts on disk (most recent first):",
  ];
  const ranked = listEfforts(cwd)
    .efforts.map((e) => {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(join(cwd, ".planning", e.slug, "map.md")).mtimeMs;
      } catch {
        // unreadable map.md — rank last (mtime 0), still listed
      }
      return { e, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.e.slug.localeCompare(b.e.slug));
  if (ranked.length === 0) lines.push("  (none — chart one with /wayfind <destination>)");
  for (const { e } of ranked.slice(0, 10)) {
    lines.push(
      `  ${e.slug}${e.slug === activeEffort ? " (active)" : ""} — ${e.status} · open ${e.ticketCounts.open} / closed ${e.ticketCounts.closed}`,
    );
  }
  if (ranked.length > 10) lines.push(`  … +${ranked.length - 10} more`);
  lines.push(
    "Next steps: inspect with /wayfind status <effort> · resume with bare /wayfind · chart new with /wayfind <destination>",
  );
  return lines.join("\n");
}
