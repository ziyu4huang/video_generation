/**
 * Injectable git operations for the project-memory autocommit hook
 * (autocommit-hook effort, tickets 03–05).
 *
 * Mirrors the never-throws seam of `pi-agent-ext-subagent/src/git-scope.ts`:
 * every method swallows errors and returns a safe default, so the autocommit
 * path can NEVER hard-error the agent. Production code uses `realGitOps`;
 * tests inject a mock to assert the commit path without touching real git.
 *
 * The merge-driver self-config helpers (resolveMergeDriverScriptPath /
 * buildMergeDriverCommand) build the per-clone `merge.pi-memory.driver` value
 * the hook seeds idempotently on first commit (ticket 05) — git merge-driver
 * config isn't committed, so the hook owns its bootstrap.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_MERGE_DRIVER_NAME } from "./constants.js";

const exec = promisify(execFile);

/** Run a git command in `cwd` with `args`; return stdout (trimmed) or `undefined`. */
async function gitText(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Run a git command; return true on exit 0, false otherwise (never throws). */
async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await exec("git", ["-C", cwd, ...args]);
    return true;
  } catch {
    return false;
  }
}

/** Status of MEMORY.md as seen by git (collected best-effort, never throws). */
export interface MemoryFileStatus {
  /** MEMORY.md is tracked by git (`git ls-files --error-unmatch`). */
  tracked: boolean;
  /** MEMORY.md exists on disk but isn't tracked (candidate for auto-track). */
  untracked: boolean;
  /** MEMORY.md matches a .gitignore rule (never force-added). */
  ignored: boolean;
  /** MEMORY.md differs from HEAD (the changed-gate from ticket 02). */
  changedSinceHead: boolean;
  /** MEMORY.md exists on disk. */
  exists: boolean;
}

/** Injectable git operations. Every method swallows errors → safe defaults. */
export interface GitOps {
  /** Resolve the absolute git dir (`.git` or worktree git dir); undefined if not a repo. */
  resolveGitDir(cwd: string): Promise<string | undefined>;
  /** Current branch name; null on detached HEAD or any error. */
  currentBranch(cwd: string): Promise<string | null>;
  /** True if a merge/rebase/cherry-pick/revert/sequencer/bisect is in progress. */
  isMidMerge(gitDir: string): Promise<boolean>;
  /** True if `.git/index.lock` exists (another git op holds the index). */
  isIndexLocked(gitDir: string): Promise<boolean>;
  /** Collect MEMORY.md's git status (tracked/ignored/changed/exists). */
  collectMemoryStatus(cwd: string, relPath: string): Promise<MemoryFileStatus>;
  /** `git add -- <relPath>` (explicit path — NEVER `-A`/`-u`). Returns true on success. */
  stage(cwd: string, relPath: string): Promise<boolean>;
  /** `git commit -m <message> -- <relPath>` (pathspec-limited so other staged files
   *  are never swept in). Returns true on success. */
  commit(cwd: string, message: string, relPath: string): Promise<boolean>;
  /** Read a `git config` value (undefined if unset). */
  getConfig(cwd: string, key: string): Promise<string | undefined>;
  /** Set a `git config` value. Returns true on success. */
  setConfig(cwd: string, key: string, value: string): Promise<boolean>;
}

/** Sentinel files/dirs git leaves while a merge/rebase/cherry-pick/… is active. */
const MID_MERGE_SENTINELS = [
  "MERGE_HEAD",
  "MERGE_MSG",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "sequencer",
] as const;

/** Git conflict-marker line patterns (the `<<<<<<<`, `=======`, `>>>>>>>`
 *  markers `git merge` writes when it cannot auto-resolve). This is a FILE-CONTENT
 *  signal (per-file), distinct from {@link GitOps.isMidMerge} which is REPO-STATE
 *  (sentinel files in `.git/`, repo-wide). Anchored to line starts to avoid false
 *  positives on normal prose: an opening/closing marker is `<<<<<<<`/`>>>>>>>` at
 *  the start of a line (optionally followed by a ref label); the divider is a
 *  WHOLE line of 7+ `=` (so `some ======= text here` is NOT flagged). */
const CONFLICT_MARKER_RE = /(^|\n)(<<<<<<<[^\n]*|>>>>>>>[^\n]*|={7,}(?=\n|$))/;

/** True when `content` contains unresolved git conflict markers. Pure; no IO.
 *  Additive export — deliberately NOT part of the {@link GitOps} interface and
 *  NOT wired into {@link GitOps.isMidMerge} (different signal: file bytes vs
 *  repo state). Used by the planning mirror (09-impl T5) to surface, for human
 *  review, effort slugs whose md still carries unresolved merge markers. */
export function hasMergeConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_RE.test(content);
}

/** Production git ops. Every call swallows errors — autocommit never hard-errors. */
export const realGitOps: GitOps = {
  async resolveGitDir(cwd) {
    const dir = await gitText(cwd, ["rev-parse", "--git-dir"]);
    if (!dir) return undefined;
    return path.resolve(cwd, dir); // worktree git-dir is absolute; main is `.git`
  },

  async currentBranch(cwd) {
    // `symbolic-ref --quiet --short HEAD` prints the branch on success and
    // exits non-zero on detached HEAD (or any error) → null.
    const branch = await gitText(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return branch || null;
  },

  async isMidMerge(gitDir) {
    return MID_MERGE_SENTINELS.some((s) => fs.existsSync(path.join(gitDir, s)));
  },

  async isIndexLocked(gitDir) {
    return fs.existsSync(path.join(gitDir, "index.lock"));
  },

  async collectMemoryStatus(cwd, relPath) {
    const absPath = path.resolve(cwd, relPath);
    const exists = fs.existsSync(absPath);
    let tracked = false;
    let ignored = false;
    let changedSinceHead = false;

    // tracked?  `git ls-files --error-unmatch` exits non-zero when untracked.
    const trackedOut = await gitText(cwd, ["ls-files", "--error-unmatch", "--", relPath]);
    tracked = !!trackedOut;

    // ignored?  `git check-ignore` exits 0 when the path IS ignored.
    if (!tracked) {
      ignored = await gitOk(cwd, ["check-ignore", "--", relPath]);
    }

    // changed since HEAD?  `git diff --quiet HEAD -- <path>` exits non-zero
    // (rejected promise) when there ARE differences. For untracked files the
    // auto-track path handles them, so this is only consulted when tracked.
    if (tracked) {
      changedSinceHead = !(await gitOk(cwd, ["diff", "--quiet", "HEAD", "--", relPath]));
    } else {
      changedSinceHead = true; // untracked → effectively new
    }

    return {
      tracked,
      untracked: !tracked && exists && !ignored,
      ignored,
      changedSinceHead,
      exists,
    };
  },

  async stage(cwd, relPath) {
    // Explicit path ONLY — never `-A`/`-u`/`.` (ticket 03). Untracked files
    // are auto-tracked here (opt-in implies wanting memory tracked, ticket 04).
    return gitOk(cwd, ["add", "--", relPath]);
  },

  async commit(cwd, message, relPath) {
    // Pathspec-limited commit: ONLY MEMORY.md is committed even if the user
    // had other files staged — the explicit `-- <relPath>` is the no-`-A` safety net.
    return gitOk(cwd, ["commit", "-m", message, "--", relPath]);
  },

  async getConfig(cwd, key) {
    return gitText(cwd, ["config", "--get", key]);
  },

  async setConfig(cwd, key, value) {
    return gitOk(cwd, ["config", key, value]);
  },
};

/**
 * Resolve the absolute path to the bundled merge-driver script
 * (`scripts/pi-memory-merge.mjs`). Lives next to `src/`, so the script is
 * `<packageRoot>/scripts/pi-memory-merge.mjs`. Overridable for tests.
 *
 * Resolution order (deliberately NOT `import.meta.url` by default: bun's cjs
 * bundler folds that into a build-machine path literal — rejected by the sh
 * deploy's relocatability gate — and REBINDS `__dirname` to the build machine
 * as well, so the sh loader serves the deployed dir through the injected
 * require instead):
 *   1. `fromUrl` injected (tests) → `<moduleDir>/../scripts/…`
 *   2. sh deploy: `require("#pi/ext-dir")` → the deploy copies `scripts/`
 *      beside the bundle (`ext/<name>/scripts/…`)
 *   3. jiti/source and dist: the package.json `"#pi/ext-dir"` imports entry
 *      (`src/sh-ext-dir.ts`, loaded by jiti as cjs with the REAL `__dirname`)
 *      → the package root, where `scripts/` lives.
 */
const EXT_DIR_SPEC = "#pi/ext-dir";

function shExtDir(): string | undefined {
  try {
    if (typeof require === "function") {
      const mod = require(EXT_DIR_SPEC) as { default?: unknown } | string;
      if (typeof mod === "string") return mod; // sh loader: the deployed ext dir
      if (mod !== null && typeof mod === "object" && typeof mod.default === "string") {
        return mod.default; // jiti/source: package.json "#pi/ext-dir" imports entry
      }
    }
  } catch {
    // Not resolvable here (native ESM / tests) — fall through.
  }
  return undefined;
}

export function resolveMergeDriverScriptPath(fromUrl?: string): string {
  if (fromUrl !== undefined) {
    const here = path.dirname(fileURLToPath(fromUrl)); // .../src
    return path.resolve(here, "..", "scripts", "pi-memory-merge.mjs");
  }
  const extDir = shExtDir();
  if (extDir !== undefined) return path.join(extDir, "scripts", "pi-memory-merge.mjs");
  return path.resolve("..", "scripts", "pi-memory-merge.mjs");
}

/**
 * Build the `merge.pi-memory.driver` command value: the current runtime
 * (`process.execPath` — bun under pi, node otherwise) invoking the bundled
 * script with git's %O (base) %A (ours/output) %B (theirs) placeholders.
 * Both paths are quoted so spaces never break the config line.
 */
export function buildMergeDriverCommand(
  scriptPath: string = resolveMergeDriverScriptPath(),
  execPath: string = process.execPath,
): string {
  return `"${execPath}" "${scriptPath}" %O %A %B`;
}

/** The git-config key for the merge-driver command (`merge.<name>.driver`). */
export function mergeDriverConfigKey(field: "name" | "driver"): string {
  return `merge.${MEMORY_MERGE_DRIVER_NAME}.${field}`;
}
