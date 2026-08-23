/**
 * `.planning/` zero-citation sweeper — enumerate finished efforts that never
 * recorded a `## Decisions so far` citation, so they can be archived out of the
 * live effort set. Pure TS, spawn-free (mirrors `tidy-next-goals.ts`); the
 * classification reuses the map model (`parseMapFrontmatter` / `parseMapBody` /
 * `parseDecisionLine`) so "zero citation" can never drift from `readMap`.
 *
 * Two surface functions:
 *   - `classifyZeroCitationEfforts(cwd)`  — READ-ONLY: enumerate + classify.
 *   - `archiveZeroCitationEfforts(cwd)`   — MUTATING: move every zero-citation
 *       COMPLETE effort into `.planning/archive/`. Never touches an
 *       active/paused effort. Callers gate this behind an explicit opt-in (the
 *       CLI's `--archive`); the default report is dry-run safe.
 *
 * "Complete" = the effort lives under `.planning/done/` (the D1 archive the
 * closing ceremony files into) OR its map front-matter says `status: complete`.
 * Nothing is ever deleted — only relocated, so git history is preserved.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseMapBody } from "./markdown.js";
import { type EffortStatus, type MapDecision, parseDecisionLine, parseMapFrontmatter } from "./model.js";

export type EffortLocation = "root" | "done";

export interface EffortSweepRecord {
  /** Effort slug (the `.planning/<slug>/` folder name). */
  effort: string;
  /** Where the effort sits: `.planning/<slug>` (root) or `.planning/done/<slug>`. */
  location: EffortLocation;
  /** Repo-relative map.md path, e.g. `.planning/done/<slug>/map.md`. */
  mapPath: string;
  /** Effort front-matter status, or null for a legacy prose-only map. */
  status: EffortStatus | null;
  /** Count of `## Decisions so far` citation lines. */
  decisionCount: number;
  /** True when `decisionCount === 0`. */
  zeroCitation: boolean;
  /** True when the effort is finished (lives in done/ OR status: complete). */
  complete: boolean;
}

export interface SweepReport {
  scanned: number;
  /** Zero-citation COMPLETE efforts — the sweep candidates (safe to archive). */
  zeroCitationComplete: EffortSweepRecord[];
  /** Zero-citation but NOT complete (active/paused/legacy) — guarded, never swept. */
  zeroCitationGuarded: EffortSweepRecord[];
  /** Efforts carrying at least one citation (kept, not swept). */
  cited: number;
  /** Per-dir read/parse failures (throw-free; a bad effort never fails the run). */
  errors: { dir: string; error: string }[];
}

export interface ArchiveResult {
  moved: string[];
  skipped: string[];
}

/** True when the effort is finished: archived under done/ or stamped complete. */
function isComplete(location: EffortLocation, status: EffortStatus | null): boolean {
  return location === "done" || status === "complete";
}

/** Classify one `.planning/<slug>` (or `.planning/done/<slug>`) effort dir. */
function classifyEffort(cwd: string, slug: string, location: EffortLocation): EffortSweepRecord | null {
  const dir = location === "done" ? join(cwd, ".planning", "done", slug) : join(cwd, ".planning", slug);
  const mapPathRel = join(location === "done" ? join(".planning", "done", slug) : join(".planning", slug), "map.md");
  const absMap = join(cwd, mapPathRel);
  if (!existsSync(absMap)) return null;

  const { meta, body } = parseMapFrontmatter(readFileSync(absMap, "utf-8"));
  const decisions = parseMapBody(body)["Decisions so far"] ?? "";
  const decisionCount = decisions
    .split(/\r?\n/)
    .map(parseDecisionLine)
    .filter((d): d is MapDecision => d !== null).length;

  const status = meta?.status ?? null;
  return {
    effort: slug,
    location,
    mapPath: mapPathRel,
    status,
    decisionCount,
    zeroCitation: decisionCount === 0,
    complete: isComplete(location, status),
  };
}

/** List `.planning/<slug>` dirs that own a `map.md` (throw-free). */
function listEffortDirs(cwd: string, sub: "" | "done"): { slug: string; location: EffortLocation }[] {
  const base = sub ? join(cwd, ".planning", sub) : join(cwd, ".planning");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((n) => {
      // Skip container dirs (done/, archive/), dotfiles, and non-dirs — these
      // are never effort folders.
      if (n.startsWith(".") || n === "done" || n === "archive") return false;
      try {
        return statSync(join(base, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((n) => ({ slug: n, location: (sub ? "done" : "root") as EffortLocation }));
}

/**
 * Read-only sweep over `.planning/`: enumerate root + `done/` efforts, classify
 * each by decision count + status, and return the dry-run report. Throw-free.
 */
export function classifyZeroCitationEfforts(cwd: string): SweepReport {
  const report: SweepReport = { scanned: 0, zeroCitationComplete: [], zeroCitationGuarded: [], cited: 0, errors: [] };
  const dirs = [...listEffortDirs(cwd, ""), ...listEffortDirs(cwd, "done")];
  for (const { slug, location } of dirs) {
    report.scanned += 1;
    try {
      const rec = classifyEffort(cwd, slug, location);
      if (!rec) continue;
      if (rec.zeroCitation) {
        if (rec.complete) report.zeroCitationComplete.push(rec);
        else report.zeroCitationGuarded.push(rec);
      } else {
        report.cited += 1;
      }
    } catch (err) {
      report.errors.push({
        dir: `${location === "done" ? "done/" : ""}${slug}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

/**
 * MUTATING: move every zero-citation COMPLETE effort into `.planning/archive/`.
 * Guarded — never touches an active/paused (nor legacy unknown-status) effort.
 * Returns the relocations; partial-safe (a failing move is reported in
 * `skipped`, not thrown). Callers must gate this behind explicit opt-in.
 */
export function archiveZeroCitationEfforts(cwd: string): ArchiveResult {
  const report = classifyZeroCitationEfforts(cwd);
  const archiveRoot = join(cwd, ".planning", "archive");
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const rec of report.zeroCitationComplete) {
    const from = join(cwd, rec.mapPath, ".."); // the effort dir
    const to = join(archiveRoot, rec.effort);
    try {
      if (existsSync(to)) {
        skipped.push(`${rec.effort} (target exists)`);
        continue;
      }
      mkdirSync(archiveRoot, { recursive: true });
      renameSync(from, to);
      moved.push(relative(cwd, to));
    } catch (err) {
      skipped.push(`${rec.effort} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { moved, skipped };
}
