/**
 * workspace-dist-staleness — pure helpers for detecting stale `dist/` builds in
 * `@repo/*` workspace packages whose package entry resolves into `./dist/`.
 *
 * WHY THIS EXISTS (incident 2026-08-15): `@repo/pi-agent-ext-workflow`'s entry
 * is `./dist/index.js` — a gitignored, locally built artifact. cf6f1394 removed
 * `homeDir` from the pi-agent-ext-subagent barrel and updated workflow's SRC to
 * import it from core-runtime, but the local dist was not rebuilt. At the next
 * `./pi-agent.sh` boot, `dist/workflow-paths.js` still imported the removed
 `homeDir` from the subagent barrel → the native import of the movie-director
 * extension graph FAILED → jiti fell back to transforming the whole graph → the
 * first >4 KB module (ltx binary.ts) got base64-wrapped into a data URL → Bun
 * died with a cryptic `NameTooLong`. CI can never catch this: dist/ is
 * gitignored, so CI always builds fresh — only a developer machine with a
 * stale local dist breaks, at boot.
 *
 * All helpers here are pure (or read-only fs walks) so they can be unit-tested
 * without touching the live workspace. The boot-time wrapper that uses them is
 * src/patches/ensure-workspace-dist.ts.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Anything under these directory names is skipped by the src mtime walk —
 * editing a test or a doc must not flag the package's dist as stale. */
const SRC_WALK_SKIP_DIRS = new Set(["node_modules", "__tests__", "tests", "fixtures"]);

/** File suffixes the src walk ignores (same reason as SRC_WALK_SKIP_DIRS). */
const SRC_WALK_SKIP_SUFFIXES = [".test.ts", ".test.js", ".md", ".json"];

/** Minimal package.json shape distEntryMain reads. */
export interface PkgJsonLike {
  main?: unknown;
  exports?: unknown;
}

/**
 * If the package's runtime entry resolves into `./dist/`, return that entry
 * (e.g. "./dist/index.js"); otherwise null. Packages whose entry is src/ (the
 * majority of this repo's extensions) have no build artifact to go stale.
 */
export function distEntryMain(pkg: PkgJsonLike): string | null {
  const candidates: unknown[] = [pkg.main];
  const dot = (pkg.exports as Record<string, { import?: unknown }> | undefined)?.["."];
  if (dot && typeof dot === "object") candidates.push(dot.import);
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("./dist/")) return c;
  }
  return null;
}

/** Inputs to the staleness decision; mtime milliseconds, null = "absent". */
export interface DistStaleness {
  newestSrcMs: number | null;
  newestDistMs: number | null;
}

/**
 * Decision: rebuild the dist? True when there IS src to compile and the dist is
 * missing or older than the newest src edit. False when there is no src
 * (nothing to compile — e.g. a dist-only package) even if dist is missing.
 */
export function shouldRebuildDist(s: DistStaleness): boolean {
  if (s.newestSrcMs === null) return false;
  if (s.newestDistMs === null) return true;
  return s.newestSrcMs > s.newestDistMs;
}

/**
 * Newest mtime (ms) among the files under `dir`, walked recursively. Returns
 * null when the directory does not exist or holds no files. Read-only.
 */
export function newestMtimeMs(dir: string, skipDirs: Set<string> = SRC_WALK_SKIP_DIRS): number | null {
  let newest: number | null = null;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable/missing — contributes nothing
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(full);
      } else if (e.isFile()) {
        try {
          const ms = statSync(full).mtimeMs;
          if (newest === null || ms > newest) newest = ms;
        } catch {
          /* raced away — ignore */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Newest mtime among COMPILABLE src files (test/doc dirs and files skipped).
 * Separate export from newestMtimeMs so the skip policy is explicit and the
 * generic walker stays reusable for dist (which skips nothing).
 */
export function newestSrcMtimeMs(srcDir: string): number | null {
  let newest: number | null = null;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SRC_WALK_SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        if (SRC_WALK_SKIP_SUFFIXES.some((sfx) => e.name.endsWith(sfx))) continue;
        try {
          const ms = statSync(full).mtimeMs;
          if (newest === null || ms > newest) newest = ms;
        } catch {
          /* raced away — ignore */
        }
      }
    }
  };
  walk(srcDir);
  return newest;
}
