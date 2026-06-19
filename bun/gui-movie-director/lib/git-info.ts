import { REPO_DIR } from "./config";

export interface GitInfo {
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

let _cached: GitInfo | null = null;

/**
 * Git branch + short commit, captured once at first call (startup). Both fields
 * are undefined when this isn't a git repo or git is unavailable — callers MUST
 * handle the missing case (never assume a value). `branch` is "HEAD" on a
 * detached HEAD; the UI collapses that to just the commit.
 */
export function getGitInfo(): GitInfo {
  if (_cached === null) {
    _cached = {
      branch: runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
      commit: runGit(["rev-parse", "--short", "HEAD"]),
    };
  }
  return _cached;
}
