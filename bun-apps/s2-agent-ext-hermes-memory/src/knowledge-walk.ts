import { readdirSync, lstatSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { planningCardKindFromPath } from "./store/planning-id.js";

/** Knowledge source families the walk classifies (Option A ingests workflow-jsonl;
 *  generic is detected-but-deferred). Memory-card sources (.agents/memory) are
 *  out of scope and reported in skipped.deferredFamily. The `planning` family
 *  (Phase-2 / 08) routes `.planning/<effort>/{map.md,tickets/NN.md}` for the
 *  seam-independent planning mirror — classified BEFORE the generic `.md`
 *  fallback so non-card `.planning` md (specs/plans/flat) stays generic/deferred. */
export interface WalkFiles {
  "workflow-jsonl": string[];
  generic: string[];
  planning: string[];
}

export interface WalkSkipped {
  /** Junk dirs pruned (.git / node_modules / _archive / .planning/sdd). */
  dirs: string[];
  /** Non-text files pruned: binary denylist + images opted out (default OFF). */
  binaries: string[];
  /** Symlinks pruned (never followed). */
  symlinks: string[];
  /** Out-of-scope families detected but not ingested (.agents/memory). */
  deferredFamily: string[];
}

export interface WalkOptions {
  /** Base dir for resolving relative inputs. Defaults to process.cwd(). */
  cwd?: string;
  /** Opt into image files (default OFF — VLM cost, ticket 07). */
  includeImages?: boolean;
}

export interface WalkResult {
  files: WalkFiles;
  skipped: WalkSkipped;
}

/** Basename-pruned junk dirs (ticket-06 policy). */
const SKIP_DIR_BASENAMES = new Set([".git", "node_modules", "_archive"]);

/** Two-segment junk path `.planning/sdd` (planning SDD scratch, out of scope). */
const SKIP_DIR_PATH = ".planning/sdd";

/** Binary denylist by extension — archives, executables, media (pdf = ticket 02). */
const BINARY_EXT = new Set<string>([
  ".zip", ".gz", ".tar", ".7z", ".rar", // archives
  ".exe", ".dll", ".so", ".dylib", ".bin", // executables
  ".mp4", ".mov", ".mp3", ".pdf", // media
]);

/** Image extensions — OPT-IN (default OFF). */
const IMAGE_EXT = new Set<string>([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function isUnderAgentsMemory(relSegments: string[]): boolean {
  const i = relSegments.indexOf(".agents");
  return i >= 0 && i + 1 < relSegments.length && relSegments[i + 1] === "memory";
}

function isUnderPlanningSdd(relSegments: string[]): boolean {
  const i = relSegments.indexOf(".planning");
  return i >= 0 && i + 1 < relSegments.length && relSegments[i + 1] === "sdd";
}

function shouldSkipDir(abs: string, root: string, basename: string): boolean {
  if (SKIP_DIR_BASENAMES.has(basename)) return true;
  const rel = relative(root, abs);
  const segs = rel.split(/[\\/]/);
  if (rel === SKIP_DIR_PATH || isUnderPlanningSdd(segs)) return true;
  return false;
}

function emptyResult(): WalkResult {
  return {
    files: { "workflow-jsonl": [], generic: [], planning: [] },
    skipped: { dirs: [], binaries: [], symlinks: [], deferredFamily: [] },
  };
}

function classify(abs: string, root: string, result: WalkResult, opts: WalkOptions): void {
  const ext = extname(abs).toLowerCase();
  const rel = relative(root, abs);
  const segs = rel.split(/[\\/]/);

  // Family: .agents/memory/** → deferred (memory cards, out of scope).
  if (isUnderAgentsMemory(segs)) {
    result.skipped.deferredFamily.push(abs);
    return;
  }

  // Images: opt-in, default OFF.
  if (IMAGE_EXT.has(ext)) {
    if (!opts.includeImages) result.skipped.binaries.push(abs);
    // When opted in, no knowledge family ingests images yet (ticket 07) — pass through silently.
    return;
  }

  // Family: .knowledge.jsonl → workflow-jsonl; .md → generic.
  if (abs.endsWith(".knowledge.jsonl")) {
    result.files["workflow-jsonl"].push(abs);
    return;
  }
  if (ext === ".md") {
    // Classify planning from the ABSOLUTE path (the canonical classifier used
    // by mirrorPlanningToStore / parsePlanningPath everywhere else). The rel
    // segments are relative to the walk `root`, so a bare-file input (root ===
    // file) or a `.planning/`-rooted walk would strip the `.planning` segment
    // and misclassify a planning card as generic. The abs path always retains
    // it, so classification is correct for any input form (dir, file, or list).
    if (planningCardKindFromPath(abs)) {
      result.files.planning.push(abs);
      return;
    }
    result.files.generic.push(abs);
    return;
  }
  // No knowledge family + not an explicit skip → ignore (unknown text).
}

function walkDir(abs: string, root: string, opts: WalkOptions, result: WalkResult): void {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(abs, entry.name);
    let st;
    try {
      st = lstatSync(child);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      result.skipped.symlinks.push(child);
      continue;
    }
    if (st.isDirectory()) {
      if (shouldSkipDir(child, root, entry.name)) {
        result.skipped.dirs.push(child);
        continue;
      }
      walkDir(child, root, opts, result); // unlimited depth
      continue;
    }
    if (st.isFile()) {
      const ext = extname(child).toLowerCase();
      if (BINARY_EXT.has(ext)) {
        result.skipped.binaries.push(child);
        continue;
      }
      classify(child, root, result, opts);
    }
  }
}

function dedupeSorted(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

/** Policy walk + source-family detection (ticket-06). Recursively expands `input`
 *  (a dir or file, absolute or relative to opts.cwd) applying the skip policy:
 *  skip junk dirs (.git/node_modules/_archive/.planning/sdd), skip symlinks
 *  (lstat, never follow), skip binaries (denylist by extension), images OPT-IN
 *  (default OFF), unlimited depth. Classifies by family (.knowledge.jsonl →
 *  workflow-jsonl; .md → generic; .agents/memory → deferred). NO seam call, NO
 *  writes. Returns absolute, sorted, unique paths grouped by family + a skipped
 *  breakdown. */
export function walkKnowledgeSources(input: string | string[], opts: WalkOptions = {}): WalkResult {
  const cwd = opts.cwd ?? process.cwd();
  const inputs = Array.isArray(input) ? input : [input];
  const result = emptyResult();
  for (const raw of inputs) {
    // resolve() honors absolute inputs as-is and resolves relative ones against cwd.
    const abs = resolve(cwd, raw);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      result.skipped.symlinks.push(abs);
      continue;
    }
    if (st.isDirectory()) {
      walkDir(abs, abs, opts, result);
      continue;
    }
    if (st.isFile()) {
      const ext = extname(abs).toLowerCase();
      if (BINARY_EXT.has(ext)) {
        result.skipped.binaries.push(abs);
        continue;
      }
      classify(abs, abs, result, opts);
    }
  }
  result.files["workflow-jsonl"] = dedupeSorted(result.files["workflow-jsonl"]);
  result.files.generic = dedupeSorted(result.files.generic);
  result.files.planning = dedupeSorted(result.files.planning);
  result.skipped.dirs = dedupeSorted(result.skipped.dirs);
  result.skipped.binaries = dedupeSorted(result.skipped.binaries);
  result.skipped.symlinks = dedupeSorted(result.skipped.symlinks);
  result.skipped.deferredFamily = dedupeSorted(result.skipped.deferredFamily);
  return result;
}
