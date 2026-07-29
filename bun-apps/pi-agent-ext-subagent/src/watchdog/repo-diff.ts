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

function git(cwd: string, args: string[]): string | undefined {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

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
    const tok = tokens[i]!;
    if (tok.length < 4) continue;
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

export function computeBaseline(cwd: string): RepoBaseline | undefined {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) return undefined;
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
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

/** A textual changeset for L2: `git diff HEAD` for tracked + raw content for untracked. */
export function diffTextForReview(cwd: string, paths: string[]): string {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim() ?? cwd;
  const parts: string[] = [];
  const diff = git(root, ["diff", "HEAD", "--", ...paths]);
  if (diff) parts.push(diff);
  // Untracked (not yet in HEAD): include their content under a header.
  const tracked = new Set((git(root, ["ls-files"]) ?? "").split("\n").filter(Boolean));
  for (const p of paths) {
    if (tracked.has(p)) continue;
    try {
      const body = fs.readFileSync(path.join(root, p), "utf-8");
      parts.push(`--- new file: ${p} ---\n${body}`);
    } catch {
      /* gone */
    }
  }
  return parts.join("\n").slice(0, 200_000);
}
