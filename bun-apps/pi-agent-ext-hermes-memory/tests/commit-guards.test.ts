/**
 * Unit tests for the pure commit-guard classifier (autocommit-hook effort,
 * ticket 04). Given a repo-state snapshot, classifyCommitGuard returns one of
 * {commit, skip, defer, suppress} — NO git, NO filesystem. The commit path
 * honors every guard decision (tested in commit-project-memory.test.ts).
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  classifyCommitGuard,
  PROTECTED_BRANCHES,
  isProtectedBranch,
  type RepoStateSnapshot,
} from "../src/commit-guards.js";

/** A snapshot where every guard is clear → decision is "commit". */
function clearState(): RepoStateSnapshot {
  return {
    optedIn: true,
    projectMemoryDirEnabled: true,
    isRepo: true,
    branch: "feature/durable-memory",
    isProtectedBranch: false,
    midMerge: false,
    indexLocked: false,
    consolidationInFlight: false,
    fileLockHeld: false,
    memoryTracked: true,
    memoryUntracked: false,
    memoryIgnored: false,
    changedSinceHead: true,
    memoryExists: true,
  };
}

describe("classifyCommitGuard (pure, ticket 04)", () => {
  it("commits when every guard is clear", () => {
    const d = classifyCommitGuard(clearState());
    assert.strictEqual(d.decision, "commit");
    assert.ok(d.reason.length > 0);
  });

  // ── skip conditions (permanent-ish — no re-arm) ──────────────────────

  it("skips when not opted in", () => {
    const d = classifyCommitGuard({ ...clearState(), optedIn: false });
    assert.strictEqual(d.decision, "skip");
  });

  it("skips when projectMemoryDir is null (global opt-out; nothing in-repo)", () => {
    const d = classifyCommitGuard({ ...clearState(), projectMemoryDirEnabled: false });
    assert.strictEqual(d.decision, "skip");
  });

  it("skips when not a git repo", () => {
    const d = classifyCommitGuard({ ...clearState(), isRepo: false, branch: null });
    assert.strictEqual(d.decision, "skip");
  });

  it("skips on detached HEAD (branch null)", () => {
    const d = classifyCommitGuard({ ...clearState(), branch: null });
    assert.strictEqual(d.decision, "skip");
  });

  it("skips mid merge/rebase/cherry-pick", () => {
    const d = classifyCommitGuard({ ...clearState(), midMerge: true });
    assert.strictEqual(d.decision, "skip");
  });

  it("skips when MEMORY.md is gitignored (won't force-add an explicit exclude)", () => {
    const d = classifyCommitGuard({ ...clearState(), memoryIgnored: true });
    assert.strictEqual(d.decision, "skip");
  });

  it("skips when MEMORY.md is unchanged since HEAD (changed-gate)", () => {
    const d = classifyCommitGuard({ ...clearState(), changedSinceHead: false });
    assert.strictEqual(d.decision, "skip");
  });

  it("skips when MEMORY.md does not exist (nothing to commit)", () => {
    const d = classifyCommitGuard({ ...clearState(), memoryExists: false });
    assert.strictEqual(d.decision, "skip");
  });

  // ── suppress (protected/main — distinct outcome) ─────────────────────

  it("suppresses on a protected branch (main/master/develop)", () => {
    for (const branch of ["main", "master", "develop"]) {
      const d = classifyCommitGuard({ ...clearState(), branch, isProtectedBranch: true });
      assert.strictEqual(d.decision, "suppress", `suppress on ${branch}`);
    }
  });

  // ── defer (transient contention — re-arm the debounce) ───────────────

  it("defers while consolidation is in flight", () => {
    const d = classifyCommitGuard({ ...clearState(), consolidationInFlight: true });
    assert.strictEqual(d.decision, "defer");
  });

  it("defers while the memory file lock is held", () => {
    const d = classifyCommitGuard({ ...clearState(), fileLockHeld: true });
    assert.strictEqual(d.decision, "defer");
  });

  it("defers when the git index is locked", () => {
    const d = classifyCommitGuard({ ...clearState(), indexLocked: true });
    assert.strictEqual(d.decision, "defer");
  });

  // ── auto-track (untracked MEMORY.md → commit via git add) ─────────────

  it("commits (auto-tracks) an untracked, non-ignored MEMORY.md", () => {
    const d = classifyCommitGuard({
      ...clearState(),
      memoryTracked: false,
      memoryUntracked: true,
      changedSinceHead: false, // untracked isn't "changed vs HEAD"; auto-track wins
    });
    assert.strictEqual(d.decision, "commit");
  });

  it("suppress beats defer (protected branch wins over transient contention)", () => {
    // No point deferring a commit that can never land on a protected branch.
    const d = classifyCommitGuard({
      ...clearState(),
      isProtectedBranch: true,
      branch: "main",
      indexLocked: true,
    });
    assert.strictEqual(d.decision, "suppress");
  });

  it("skip (not opted in) beats every other guard", () => {
    const d = classifyCommitGuard({
      ...clearState(),
      optedIn: false,
      isProtectedBranch: true,
      midMerge: true,
      indexLocked: true,
    });
    assert.strictEqual(d.decision, "skip");
  });

  it("ignored beats untracked (a gitignored file is never force-added)", () => {
    const d = classifyCommitGuard({
      ...clearState(),
      memoryTracked: false,
      memoryUntracked: true,
      memoryIgnored: true,
    });
    assert.strictEqual(d.decision, "skip");
  });
});

describe("PROTECTED_BRANCHES / isProtectedBranch", () => {
  it("includes a small, defensible protected set", () => {
    assert.ok(PROTECTED_BRANCHES.has("main"));
    assert.ok(PROTECTED_BRANCHES.has("master"));
    assert.ok(PROTECTED_BRANCHES.has("develop"));
  });

  it("isProtectedBranch is exact-match (a feature branch is never protected)", () => {
    assert.strictEqual(isProtectedBranch("main"), true);
    assert.strictEqual(isProtectedBranch("feature/x"), false);
    assert.strictEqual(isProtectedBranch("maint"), false); // prefix must not match
  });
});
