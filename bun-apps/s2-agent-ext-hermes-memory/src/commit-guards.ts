/**
 * Pure commit-guard classifier for the project-memory autocommit hook
 * (autocommit-hook effort, ticket 04).
 *
 * Given a repo-state snapshot (collected separately — NO git, NO filesystem
 * here), classifyCommitGuard returns one of {commit, skip, defer, suppress}:
 *   - commit   → stage + commit MEMORY.md now
 *   - skip     → no-op this cycle; do NOT re-arm (permanent-ish reason)
 *   - defer    → transient contention; re-arm the debounce (next message_end)
 *   - suppress → protected branch; never commit, log only
 *
 * The guards are best-effort: the surrounding commit path NEVER hard-errors
 * (git failures are swallowed). This pure function only decides WHAT to do.
 */

/** The autocommit action to take for one debounce fire. */
export type CommitDecision = "commit" | "skip" | "defer" | "suppress";

/**
 * A snapshot of repo state relevant to the autocommit decision. Collected by
 * the handler (via injectable GitOps + env + fs) before classification — this
 * module never touches git or the filesystem, so the classifier is unit-testable.
 */
export interface RepoStateSnapshot {
  /** Repo opted in via `.agents/memory/config.json` `autoCommitProjectMemory`. */
  optedIn: boolean;
  /** config.projectMemoryDir !== null (in-repo memory enabled). */
  projectMemoryDirEnabled: boolean;
  /** `git rev-parse --git-dir` resolved (a git repo). */
  isRepo: boolean;
  /** Current branch name; null = detached HEAD or unresolvable. */
  branch: string | null;
  /** Branch is in the protected set (main/master/develop). */
  isProtectedBranch: boolean;
  /** A merge/rebase/cherry-pick/revert is in progress (`.git/MERGE_HEAD`, …). */
  midMerge: boolean;
  /** `.git/index.lock` exists (another git op holds the index). */
  indexLocked: boolean;
  /** A memory consolidation is rewriting MEMORY.md (PI_HERMES_CONSOLIDATING). */
  consolidationInFlight: boolean;
  /** The memory file lock is held (a write is in progress). */
  fileLockHeld: boolean;
  /** MEMORY.md is tracked by git. */
  memoryTracked: boolean;
  /** MEMORY.md is untracked (exists on disk, not yet `git add`-ed). */
  memoryUntracked: boolean;
  /** MEMORY.md matches a .gitignore rule (never force-add an explicit exclude). */
  memoryIgnored: boolean;
  /** MEMORY.md differs from HEAD (the changed-gate from ticket 02). */
  changedSinceHead: boolean;
  /** MEMORY.md exists on disk. */
  memoryExists: boolean;
}

/** The outcome of classification: the decision + a human-readable reason. */
export interface GuardDecision {
  decision: CommitDecision;
  reason: string;
}

/**
 * Branches the hook SUPPRESSES (never auto-commits to). A protected branch
 * can't be pushed directly (branch protection) and direct-to-main bypasses
 * PR review, so memory there stays uncommitted (it lands when authored in a
 * feature worktree or committed manually). Exact-match only — a feature
 * branch is never suppressed. Keep this set SMALL and defensible.
 */
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set([
  "main",
  "master",
  "develop",
]);

/** Exact-match protected-branch check. */
export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch);
}

/**
 * Pure: classify a repo-state snapshot into a commit decision.
 *
 * Guard order (first match wins):
 *   1. not opted in                      → skip
 *   2. projectMemoryDir null (opt-out)   → skip
 *   3. not a git repo                    → skip
 *   4. detached HEAD (branch null)       → skip
 *   5. protected branch                  → suppress
 *   6. mid merge/rebase/cherry-pick/...  → skip
 *   7. MEMORY.md absent                   → skip
 *   8. consolidation in flight           → defer
 *   9. memory file lock held             → defer
 *  10. git index locked                  → defer
 *  11. MEMORY.md gitignored              → skip
 *  12. MEMORY.md untracked (not ignored) → commit (auto-track)
 *  13. MEMORY.md unchanged since HEAD    → skip
 *  14. otherwise                         → commit
 *
 * Rationale for ordering: opt-in/repo/topology checks are structural
 * (never change within a cycle) and come first; transient contention
 * (consolidation/file-lock/index-lock) defers so the next message_end retries;
 * the protected-branch suppress is checked BEFORE transient contention because
 * there is no point deferring a commit that can never land on a protected branch.
 */
export function classifyCommitGuard(state: RepoStateSnapshot): GuardDecision {
  if (!state.optedIn) {
    return { decision: "skip", reason: "autocommit not opted in" };
  }
  if (!state.projectMemoryDirEnabled) {
    return { decision: "skip", reason: "projectMemoryDir is null (global opt-out); nothing in-repo to commit" };
  }
  if (!state.isRepo) {
    return { decision: "skip", reason: "not a git repo" };
  }
  if (state.branch === null) {
    return { decision: "skip", reason: "detached HEAD or branch unresolvable" };
  }
  if (state.isProtectedBranch) {
    return { decision: "suppress", reason: `protected branch (${state.branch}); suppress direct-to-protected commit` };
  }
  if (state.midMerge) {
    return { decision: "skip", reason: "merge/rebase/cherry-pick/revert in progress" };
  }
  if (!state.memoryExists) {
    return { decision: "skip", reason: "MEMORY.md does not exist" };
  }
  if (state.consolidationInFlight) {
    return { decision: "defer", reason: "memory consolidation in flight" };
  }
  if (state.fileLockHeld) {
    return { decision: "defer", reason: "memory file lock held (write in progress)" };
  }
  if (state.indexLocked) {
    return { decision: "defer", reason: "git index locked" };
  }
  if (state.memoryIgnored) {
    return { decision: "skip", reason: "MEMORY.md is gitignored (won't force-add an explicit exclude)" };
  }
  if (!state.memoryTracked) {
    // Untracked + not ignored → auto-track (opt-in implies wanting memory tracked).
    return { decision: "commit", reason: "untracked MEMORY.md → auto-track (opt-in)" };
  }
  if (!state.changedSinceHead) {
    return { decision: "skip", reason: "MEMORY.md unchanged since HEAD" };
  }
  return { decision: "commit", reason: "all guards clear" };
}
