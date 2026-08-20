/**
 * Housekeeping for `<effortDir>/output/next-goal-*.md` goal notes — a faithful
 * TS port of the former `scripts/tidy-next-goals.sh` (see project memory:
 * next-goal-naming-sop). Two phases, byte-for-byte with the bash semantics:
 *
 *   1. Normalize non-canonical filenames to `next-goal-YYYYMMDD_HHMMSS.md`:
 *        • dash separator  -> underscore   (next-goal-20260706-0531.md -> _053100)
 *        • missing seconds  -> padded with '0' (next-goal-20260705_1100.md -> _110000)
 *        • already-canonical names are left untouched (idempotent).
 *        • unparsable timestamps are skipped (never renamed).
 *   2. Retention: keep only the N newest (default 10). Sort the fixed-width
 *      names lexicographically descending (== newest-first) and unlink
 *      everything past the N newest.
 *
 * Idempotent: a second run is a no-op. Pure TS — no external process spawn
 * (directive: subagent/wayfind tooling = pure s2-agent extension).
 *
 * Deviation from the bash script: a MISSING `output/` dir is a no-op rather
 * than `mkdir -p`. In the real call path `/wayfind done` writes the note (and
 * thus creates `output/`) before tidy runs, so the dir always exists there;
 * a missing dir has nothing to tidy anyway.
 */

import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { NEXT_GOAL_FILENAME_RE } from "./wayfinder.js";

/** Strip the `next-goal-` prefix + `.md` suffix → YYYYMMDD[-_]HHMM(SS)?.
 *  Matches the bash `tok="${base#next-goal-}"; tok="${tok%.md}"`. */
const PARSE_TS_RE = /^([0-9]{8})[-_]([0-9]{4,6})$/;

export interface TidyResult {
  /** Files renamed to the canonical `next-goal-YYYYMMDD_HHMMSS.md` form. */
  normalized: number;
  /** Files unlinked past the keepN newest. */
  removed: number;
}

/** Pad a 4–6 digit time component to fixed 6 digits by appending '0's, matching
 *  `while [ "${#t}" -lt 6 ]; do t="${t}0"; done`. */
function padTime(t: string): string {
  return t.length < 6 ? t.padEnd(6, "0") : t;
}

/** Canonical name for a parsable next-goal basename, or `null` if the timestamp
 *  is unparsable. Mirrors the bash `[[ "$tok" =~ ^([0-9]{8})[-_]([0-9]{4,6})$ ]]`
 *  branch (d + padded t → `next-goal-${d}_${t}.md`). */
function canonicalName(base: string): string | null {
  const tok = base.slice("next-goal-".length, base.length - ".md".length); // strip prefix + suffix
  const m = PARSE_TS_RE.exec(tok);
  if (!m) return null;
  return `next-goal-${m[1]}_${padTime(m[2])}.md`;
}

/** Basenames of regular `next-goal-*.md` files in `outDir` (matches bash
 *  `find … -maxdepth 1 -type f -name 'next-goal-*.md'`). */
function listNextGoalFiles(outDir: string): string[] {
  return readdirSync(outDir).filter(
    (n) => n.startsWith("next-goal-") && n.endsWith(".md") && statSync(join(outDir, n)).isFile(),
  );
}

/**
 * Tidy `<effortDir>/output/next-goal-*.md` goal notes:
 *   1. normalize non-canonical filenames to `next-goal-YYYYMMDD_HHMMSS.md`,
 *   2. keep only the `keepN` newest (default 10), unlinking the rest.
 *
 * No-op (returns `{normalized: 0, removed: 0}`) when `<effortDir>/output/` is
 * missing/empty or holds no `next-goal-*.md` files. Non-next-goal files in
 * `output/` are never touched. Idempotent. Does not create the `output/` dir.
 */
export function tidyNextGoals(effortDir: string, keepN = 10): TidyResult {
  const outDir = join(effortDir, "output");
  const result: TidyResult = { normalized: 0, removed: 0 };
  if (!existsSync(outDir)) return result;

  // ── Phase 1: normalize filenames ──────────────────────────────────────────
  for (const base of listNextGoalFiles(outDir)) {
    if (NEXT_GOAL_FILENAME_RE.test(base)) continue; // already canonical → skip
    const target = canonicalName(base);
    if (target === null) continue; // unparsable timestamp → skip
    // Rename iff (name would change) AND (target doesn't already exist) — no
    // collision clobber (matches bash `base != new && ! -e new`).
    if (base !== target && !existsSync(join(outDir, target))) {
      renameSync(join(outDir, base), join(outDir, target));
      result.normalized += 1;
    }
  }

  // ── Phase 2: keep only the N newest ────────────────────────────────────────
  // Re-read after renames; lexicographic DESC on the fixed-width names ==
  // newest-first (matches bash `find … | sort -r`). Drop the KEEP newest, unlink
  // the rest (`tail -n +$((KEEP+1))`).
  const names = listNextGoalFiles(outDir);
  if (names.length > keepN) {
    names.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)); // descending
    for (const base of names.slice(keepN)) {
      unlinkSync(join(outDir, base));
      result.removed += 1;
    }
  }

  return result;
}
