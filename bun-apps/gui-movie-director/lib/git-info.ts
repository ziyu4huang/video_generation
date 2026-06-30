import path from "path";
import { REPO_DIR } from "./config";

export interface GitInfo {
  folder: string; // worktree dir basename — stable identity across multi-worktree servers
  branch?: string;
  commit?: string; // short hash
}

/** Run a git command in the repo; undefined on any failure (no repo / git missing). */
function runGit(args: string[]): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: REPO_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return undefined;
    const out = new TextDecoder().decode(proc.stdout).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

// The worktree dir basename never changes during a server's lifetime, so it's a
// cheap const (no subprocess). branch/commit are read LIVE on every call so the
// UI title tracks branch switches without a server restart — the only caller is
// the page-mount /api/server-info fetch, so the per-call git cost is negligible.
const WORKTREE_FOLDER = path.basename(REPO_DIR);

/**
 * Worktree folder + git branch + short commit. branch/commit are read live on
 * every call (no caching) — callers MUST handle a missing branch/commit (not a
 * git repo / git unavailable); `folder` is always present. `branch` is "HEAD" on
 * a detached HEAD; the UI collapses that to just the commit.
 */
export function getGitInfo(): GitInfo {
  return {
    folder: WORKTREE_FOLDER,
    branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: runGit(["rev-parse", "--short", "HEAD"]),
  };
}
