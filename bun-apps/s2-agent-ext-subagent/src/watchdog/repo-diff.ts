// src/watchdog/repo-diff.ts — simplified port of pi-subagents change-signature.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const IGNORED_SEGMENTS = new Set([".git", "node_modules", ".pi-subagents"]);
const TS_JS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface RepoBaseline {
  root: string;
  key: string;
  changedPaths: string[];
}

/**
 * Injectable git operations for repo-diff. Mirrors the `GitScopeOps` seam in
 * git-scope.ts: tests inject a mock so they never spawn a host `git` binary
 * (hermetic → passes the test-portability audit), while production callers use
 * `realRepoGitOps`. Only the git subprocess calls are injected; `readFile` for
 * untracked content stays a direct `fs.readFileSync` (no portability concern).
 */
export interface RepoGitOps {
  /** `git rev-parse --show-toplevel`; undefined when not a repo / git fails. */
  toplevel(cwd: string): string | undefined;
  /** `git status --porcelain=v1 -z --untracked-files=all`; undefined on failure. */
  statusPorcelainAll(cwd: string): string | undefined;
  /** `git diff HEAD -- <paths>`; undefined on failure. */
  diffHead(cwd: string, paths: string[]): string | undefined;
  /** `git ls-files`; undefined on failure. */
  lsFiles(cwd: string): string | undefined;
}

/** Runs `git -C <cwd> <args>` and returns stdout on success, else undefined. */
function gitRaw(cwd: string, args: string[]): string | undefined {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

/** Production git ops via spawnSync (synchronous, mirrors the original helper). */
export const realRepoGitOps: RepoGitOps = {
  toplevel(cwd: string): string | undefined {
    return gitRaw(cwd, ["rev-parse", "--show-toplevel"]);
  },
  statusPorcelainAll(cwd: string): string | undefined {
    return gitRaw(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  },
  diffHead(cwd: string, paths: string[]): string | undefined {
    return gitRaw(cwd, ["diff", "HEAD", "--", ...paths]);
  },
  lsFiles(cwd: string): string | undefined {
    return gitRaw(cwd, ["ls-files"]);
  },
};

function norm(p: string): string {
  return p.replaceAll(path.sep, "/").replace(/^\.\//, "");
}
function ignored(p: string): boolean {
  const n = norm(p);
  return n.split("/").some((s) => IGNORED_SEGMENTS.has(s));
}

function parsePorcelainZ(raw: string): Array<{ status: string; paths: string[] }> {
  const tokens = raw.split("\0").filter(Boolean);
  const out: Array<{ status: string; paths: string[] }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok || tok.length < 4) continue;
    const status = tok.slice(0, 2);
    const rel = norm(tok.slice(3));
    const paths = [rel];
    if (status[0] === "R" || status[0] === "C") {
      const orig = tokens[++i];
      if (orig) paths.push(norm(orig));
    }
    out.push({ status, paths });
  }
  return out;
}

function hashEntry(root: string, rel: string, budget: { entries: number; bytes: number }): unknown {
  if (budget.entries >= MAX_ENTRIES) return { path: rel, state: "skipped" };
  budget.entries++;
  const full = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return { path: rel, state: "deleted" };
  }
  if (stat.isDirectory()) return { path: rel, state: "dir" };
  if (!stat.isFile()) return { path: rel, state: "other" };
  let hash: string;
  if (stat.size > MAX_FILE_BYTES || budget.bytes + stat.size > MAX_TOTAL_BYTES) {
    hash = `large:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } else {
    try {
      hash = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      budget.bytes += stat.size;
    } catch {
      hash = `large:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    }
  }
  return { path: rel, state: "file", size: stat.size, hash };
}

export function computeBaseline(cwd: string, gitOps: RepoGitOps = realRepoGitOps): RepoBaseline | undefined {
  const root = gitOps.toplevel(cwd)?.trim();
  if (!root) return undefined;
  const status = gitOps.statusPorcelainAll(root);
  if (status === undefined) return undefined;
  const entries = parsePorcelainZ(status)
    .map((e) => ({ status: e.status, paths: e.paths.filter((p) => !ignored(p)) }))
    .filter((e) => e.paths.length);
  const changedPaths = [...new Set(entries.flatMap((e) => e.paths))].sort();
  const budget = { entries: 0, bytes: 0 };
  const payload = entries.map((e) => ({
    status: e.status,
    paths: e.paths,
    content: e.paths.map((p) => hashEntry(root, p, budget)),
  }));
  return { root, key: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), changedPaths };
}

/** Post-spawn TS/JS dirty paths (over-inclusive of pre-dirty in a dirty tree; exact when tree was clean — the SDD target case). */
export function changedTsJsPaths(_before: RepoBaseline, after: RepoBaseline): string[] {
  return after.changedPaths.filter((p) => TS_JS_EXT.has(path.extname(p).toLowerCase()));
}

/** Result of curating a changeset for L2 review (ticket 04: curation + truncation flag). */
export interface DiffForReview {
  /** Curated diff text for the model (noise dropped; per-file budget in a later cycle). */
  text: string;
  /** True if ANY content was dropped (noise filter or budget truncation). */
  truncated: boolean;
  /** Paths dropped by the conservative noise filter (lockfiles/generated). */
  droppedNoiseFiles: string[];
  /** Paths truncated by the per-file budget (populated when budget curation lands). */
  truncatedFiles: string[];
}

/**
 * Conservative noise filter (ticket 04): drop pure-noise paths so L2's budget goes
 * to real code. Drops lockfiles + generated artifacts; **KEEPS vendored source**
 * (this repo edits vendor files via `vendor_patches.py` — those are real changes).
 */
const NOISE_LOCKFILES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
]);
function isNoisePath(relPath: string): boolean {
  const lower = norm(relPath).toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (NOISE_LOCKFILES.has(base)) return true;
  if (base.endsWith(".lock")) return true;
  if (lower.startsWith("dist/") || lower.includes("/dist/")) return true;
  if (lower.startsWith("build/") || lower.includes("/build/")) return true;
  if (lower.endsWith(".min.js") || lower.endsWith(".min.mjs") || lower.endsWith(".min.css")) return true;
  if (lower.endsWith(".map")) return true;
  return false;
}

const PER_FILE_FLOOR = 512;

/** Split a combined `git diff` into per-file sections on the `diff --git ` boundary. */
function splitDiffSections(diff: string): string[] {
  return diff
    .split(/(?=^diff --git )/m)
    .map((s) => s.replace(/^\n+/, ""))
    .filter(Boolean);
}

/** Best-effort path extraction from a section header (for truncatedFiles reporting). */
function sectionPath(section: string): string {
  const tracked = section.match(/^diff --git a\/(\S+)/);
  if (tracked?.[1]) return tracked[1];
  const untracked = section.match(/^--- new file: (.+?) ---/);
  if (untracked?.[1]) return untracked[1];
  return (section.split("\n")[0] ?? section).slice(0, 60);
}

/** A textual changeset for L2: `git diff HEAD` for tracked + raw content for untracked, with conservative curation + per-file budget. */
export function diffTextForReview(
  cwd: string,
  paths: string[],
  gitOps: RepoGitOps = realRepoGitOps,
  maxBytes = 200_000,
): DiffForReview {
  const root = gitOps.toplevel(cwd)?.trim() ?? cwd;
  const droppedNoiseFiles = paths.filter((p) => isNoisePath(p));
  const reviewPaths = paths.filter((p) => !isNoisePath(p));

  // Build per-file sections: tracked via one `git diff HEAD`, untracked via raw read.
  const trackedSections = splitDiffSections(gitOps.diffHead(root, reviewPaths) ?? "");
  const tracked = new Set((gitOps.lsFiles(root) ?? "").split("\n").filter(Boolean));
  const untrackedSections: string[] = [];
  for (const p of reviewPaths) {
    if (tracked.has(p)) continue;
    try {
      const body = fs.readFileSync(path.join(root, p), "utf-8");
      untrackedSections.push(`--- new file: ${p} ---\n${body}`);
    } catch {
      /* gone */
    }
  }
  const sections = [...trackedSections, ...untrackedSections];

  // Per-file budget: fair share (maxBytes/N, floored) so no single file monopolizes.
  const perFileCap = sections.length ? Math.max(PER_FILE_FLOOR, Math.floor(maxBytes / sections.length)) : maxBytes;
  const truncatedFiles: string[] = [];
  const capped = sections.map((sec) => {
    if (sec.length > perFileCap) {
      truncatedFiles.push(sectionPath(sec));
      return sec.slice(0, perFileCap);
    }
    return sec;
  });
  const joined = capped.join("\n");
  const text = joined.slice(0, maxBytes); // final safety cap (floor can inflate total)
  return {
    text,
    truncated: droppedNoiseFiles.length > 0 || truncatedFiles.length > 0 || text.length < joined.length,
    droppedNoiseFiles,
    truncatedFiles,
  };
}
