/**
 * Project-memory autocommit hook (autocommit-hook effort, tickets 01–05).
 *
 * When a repo opts in (`<cwd>/.agents/memory/config.json` →
 * `autoCommitProjectMemory: true`), agent writes to `.agents/memory/MEMORY.md`
 * are auto-committed to the current (non-protected) branch, batched per
 * session via a ~20s trailing debounce on `message_end` (ticket 02). Memory
 * becomes durable in git.
 *
 * The hook is a COMPLETE no-op for repos that don't opt in: setup returns
 * immediately without registering a message_end handler (zero behavior change).
 *
 * Design (settled in the ticket Resolutions):
 *  - Trigger (02):  message_end + ~20s trailing debounce, changed-gate.
 *  - Content (03):  stage ONLY MEMORY.md (explicit path, never `-A`); fixed
 *                   message `docs(memory): auto-update project memory`.
 *  - Safety (04):   best-effort guard set, NEVER hard-errors (swallow every
 *                   git failure in try/catch); defer+re-arm on transient contention.
 *  - Topology (05): commit on the current branch; SUPPRESS on protected/main;
 *                   self-config the §-union merge driver idempotently.
 *
 * Two units, both injectable-seam (tests never hit real git):
 *   - runCommitCycle: collect state (GitOps) → classify (pure) → stage/commit.
 *   - setupCommitProjectMemory: wire the message_end debounce to runCommitCycle.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../types.js";
import {
  AUTOCOMMIT_COMMIT_MESSAGE,
  DEFAULT_AUTOCOMMIT_DEBOUNCE_MS,
} from "../constants.js";
import {
  classifyCommitGuard,
  isProtectedBranch,
  type CommitDecision,
  type RepoStateSnapshot,
} from "../commit-guards.js";
import {
  realGitOps,
  buildMergeDriverCommand,
  mergeDriverConfigKey,
  type GitOps,
} from "../git-ops.js";

type Logger = (message: string, level?: "debug" | "info" | "warn") => void;
const noopLogger: Logger = () => {};

/** Inputs to one commit cycle. Tests build this directly to exercise the path. */
export interface CommitCycleDeps {
  gitOps: GitOps;
  cwd: string;
  /** Repo-relative path to MEMORY.md (what `git add`/`git commit` receive). */
  relPath: string;
  optedIn: boolean;
  projectMemoryDirEnabled: boolean;
  consolidationInFlight: boolean;
  fileLockHeld: boolean;
  commitMessage: string;
  logger?: Logger;
}

/** Build the repo-state snapshot from GitOps + injected signals, then classify. */
async function classifyFromRepo(
  deps: CommitCycleDeps,
): Promise<{ decision: CommitDecision; reason: string }> {
  const gitDir = await deps.gitOps.resolveGitDir(deps.cwd);
  const isRepo = gitDir !== undefined;
  const branch = isRepo ? await deps.gitOps.currentBranch(deps.cwd) : null;
  const midMerge = isRepo && gitDir ? await deps.gitOps.isMidMerge(gitDir) : false;
  const indexLocked = gitDir ? await deps.gitOps.isIndexLocked(gitDir) : false;
  const status = isRepo ? await deps.gitOps.collectMemoryStatus(deps.cwd, deps.relPath) : null;

  const snapshot: RepoStateSnapshot = {
    optedIn: deps.optedIn,
    projectMemoryDirEnabled: deps.projectMemoryDirEnabled,
    isRepo,
    branch,
    isProtectedBranch: branch ? isProtectedBranch(branch) : false,
    midMerge,
    indexLocked,
    consolidationInFlight: deps.consolidationInFlight,
    fileLockHeld: deps.fileLockHeld,
    memoryTracked: status?.tracked ?? false,
    memoryUntracked: status?.untracked ?? false,
    memoryIgnored: status?.ignored ?? false,
    changedSinceHead: status?.changedSinceHead ?? false,
    memoryExists: status?.exists ?? false,
  };
  return classifyCommitGuard(snapshot);
}

/**
 * Idempotently self-configure the §-union merge driver
 * (`merge.pi-memory.{name,driver}`) in the per-clone git config. Git
 * merge-driver config is NOT committed, so the hook owns its bootstrap
 * (ticket 05). Best-effort — never throws.
 */
async function selfConfigureMergeDriver(deps: CommitCycleDeps): Promise<void> {
  try {
    const expectedDriver = buildMergeDriverCommand();
    const driverKey = mergeDriverConfigKey("driver");
    const current = await deps.gitOps.getConfig(deps.cwd, driverKey);
    if (current === expectedDriver) return; // already configured identically
    await deps.gitOps.setConfig(deps.cwd, mergeDriverConfigKey("name"), "Pi memory section-union");
    await deps.gitOps.setConfig(deps.cwd, driverKey, expectedDriver);
  } catch {
    // best-effort — a missing driver just falls back to a normal merge
  }
}

/**
 * One debounce fire: collect repo state, classify, and either stage+commit
 * (ONLY MEMORY.md, fixed message) or honor the guard decision. NEVER throws
 * (best-effort, ticket 04's never-throws contract). Returns the decision so
 * the debounce layer can re-arm on "defer".
 */
export async function runCommitCycle(deps: CommitCycleDeps): Promise<CommitDecision> {
  const log = deps.logger ?? noopLogger;
  try {
    const { decision, reason } = await classifyFromRepo(deps);

    if (decision === "skip") {
      log(`autocommit skipped: ${reason}`, "debug");
      return "skip";
    }
    if (decision === "suppress") {
      log(`autocommit suppressed: ${reason}`, "debug");
      return "suppress";
    }
    if (decision === "defer") {
      log(`autocommit deferred: ${reason}`, "debug");
      return "defer";
    }

    // decision === "commit"
    const staged = await deps.gitOps.stage(deps.cwd, deps.relPath);
    if (!staged) {
      log("autocommit: git add failed — deferring to next message_end", "debug");
      return "defer";
    }
    await selfConfigureMergeDriver(deps);
    const committed = await deps.gitOps.commit(deps.cwd, deps.commitMessage, deps.relPath);
    if (!committed) {
      log("autocommit: git commit failed — deferring to next message_end", "debug");
      return "defer";
    }
    log(`autocommit committed ${deps.relPath} (${reason})`, "info");
    return "commit";
  } catch (err) {
    // NEVER hard-error: a throwing GitOps (or any surprise) is swallowed. The
    // commit lands on a future message_end; memory is already on disk (not lost).
    log(`autocommit swallowed error: ${err instanceof Error ? err.message : String(err)}`, "debug");
    return "defer";
  }
}

export interface CommitProjectMemoryOptions {
  cwd: string;
  /** Absolute path to MEMORY.md (relPath is derived cwd-relative from this). */
  memoryFilePath: string;
  commitMessage?: string;
  debounceMs?: number;
  gitOps?: GitOps;
  /** Read at fire time: true while consolidation is rewriting MEMORY.md. */
  isConsolidationInFlight?: () => boolean;
  /** Read at fire time: true while the memory file lock is held. */
  isFileLockHeld?: () => boolean;
  logger?: Logger;
  /** Test seam: inject the scheduler (default setTimeout). */
  scheduleTimer?: (cb: () => void, ms: number) => unknown;
  /** Test seam: inject the clearer (default clearTimeout). */
  clearTimer?: (handle: unknown) => void;
  /** Test seam: override the commit cycle (default runCommitCycle). */
  runCycle?: (deps: CommitCycleDeps) => Promise<CommitDecision>;
}

/**
 * Register the message_end → ~20s trailing debounce → commit hook. Returns
 * immediately (registers nothing) when the repo hasn't opted in OR project
 * memory is global (projectMemoryDir===null) — a complete no-op (ticket 01).
 */
export function setupCommitProjectMemory(
  pi: Pick<ExtensionAPI, "on">,
  config: MemoryConfig,
  opts: CommitProjectMemoryOptions,
): void {
  // Complete no-op when unconfigured (zero behavior change for non-opted-in repos).
  if (!config.autoCommitProjectMemory) return;
  if (config.projectMemoryDir === null) return;

  const gitOps = opts.gitOps ?? realGitOps;
  const schedule = opts.scheduleTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clear = opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const debounceMs = opts.debounceMs ?? DEFAULT_AUTOCOMMIT_DEBOUNCE_MS;
  const commitMessage = opts.commitMessage ?? AUTOCOMMIT_COMMIT_MESSAGE;
  const log = opts.logger ?? noopLogger;
  const runCycle = opts.runCycle ?? runCommitCycle;
  const isConsolidationInFlight = opts.isConsolidationInFlight ?? (() => process.env.PI_HERMES_CONSOLIDATING === "1");
  const isFileLockHeld = opts.isFileLockHeld ?? (() => false);

  const relPath = path.relative(opts.cwd, opts.memoryFilePath);
  const optedIn = !!config.autoCommitProjectMemory;
  const projectMemoryDirEnabled = config.projectMemoryDir !== null;

  let timer: unknown = null;

  const fire = (): void => {
    timer = null;
    // Fire-and-forget: a cycle failure is swallowed inside runCommitCycle.
    // On "defer" (transient contention) re-arm one more debounce tick (ticket 04).
    runCycle({
      gitOps,
      cwd: opts.cwd,
      relPath,
      optedIn,
      projectMemoryDirEnabled,
      consolidationInFlight: isConsolidationInFlight(),
      fileLockHeld: isFileLockHeld(),
      commitMessage,
      logger: log,
    })
      .then((decision) => {
        if (decision === "defer" && timer === null) {
          timer = schedule(fire, debounceMs);
        }
      })
      .catch(() => {
        // runCommitCycle never throws, but guard the promise chain regardless.
      });
  };

  pi.on("message_end", () => {
    // Trailing debounce: re-arm on each message_end; fire ~debounceMs after
    // the last one in a burst → one commit per burst (ticket 02).
    if (timer !== null) clear(timer);
    timer = schedule(fire, debounceMs);
  });
}
