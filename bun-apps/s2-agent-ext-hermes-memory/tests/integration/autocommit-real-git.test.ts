/**
 * Real-git integration suite for the project-memory autocommit hook
 * (ticket 08 / build ticket 02).
 *
 * Five scenarios drive the REAL hook (`setupCommitProjectMemory` + `realGitOps`)
 * against REAL `git` in isolated tmpdirs — the gap the 57 mock unit tests
 * (tests/handlers/commit-project-memory.test.ts + merge-union/commit-guards)
 * provably can't reach: a real pathspec-limited commit, real branch topology,
 * and a real §-union merge driver invoked by `git merge`.
 *
 * Scope decision (ticket 01 = A: git-level only): scenario 4 proves the
 * §-union merge driver lands a unioned MEMORY.md via a real two-branch
 * `git merge`. No second worktree / no syncMarkdownMemories (parent ticket 07
 * owns the .md→DB re-sync).
 *
 * Manual smoke (human step, not automated here): opt-in a throwaway repo,
 * eyeball a real `git log` commit + a real `git merge` union.
 */
import { describe, it, afterEach } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { setupCommitProjectMemory } from "../../src/handlers/commit-project-memory.js";
import { realGitOps } from "../../src/git-ops.js";
import { AUTOCOMMIT_COMMIT_MESSAGE, ENTRY_DELIMITER } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";
import { createRealGitRepo, type RealGitRepo } from "../helpers/real-git.js";

// Short debounce + real timers: fire fast, then await the settle. (The mock
// suite already proves the default scheduler is setTimeout; this suite's job is
// REAL GIT, not real timers.)
const DEBOUNCE_MS = 30;

// ─── mock pi (captures the message_end handler the hook registers) ───────────
interface MockPi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi: any;
  handlers: Record<string, Array<(evt?: unknown, ctx?: unknown) => void>>;
}

function createMockPi(): MockPi {
  const handlers: Record<string, Array<(evt?: unknown, ctx?: unknown) => void>> = {};
  const pi = {
    on(event: string, handler: (evt?: unknown, ctx?: unknown) => void) {
      (handlers[event] ??= []).push(handler);
    },
  };
  // The hook's first param is `Pick<ExtensionAPI, "on">`; the mock matches structurally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { pi: pi as any, handlers };
}

function emitMessageEnd(handlers: MockPi["handlers"]): void {
  for (const h of handlers["message_end"] ?? []) h({}, {});
}

/** The hook reads only `autoCommitProjectMemory` + `projectMemoryDir !== null`. */
function autocommitConfig(): MemoryConfig {
  return { autoCommitProjectMemory: true, projectMemoryDir: ".agents/memory" } as unknown as MemoryConfig;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setup(repo: RealGitRepo, pi: any, extra: Record<string, unknown> = {}): void {
  setupCommitProjectMemory(pi, autocommitConfig(), {
    cwd: repo.cwd,
    memoryFilePath: repo.memoryFilePath,
    gitOps: realGitOps,
    debounceMs: DEBOUNCE_MS,
    // Deterministic in-flight signals — never read the live env.
    isConsolidationInFlight: () => false,
    isFileLockHeld: () => false,
    ...extra,
  });
}

/** Poll until `fn` returns a non-nullish value (the real commit landing). */
async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 3000, intervalMs = 15): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null) return v;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Fixed settle for asserting an ABSENCE (a skip/defer that must not commit). */
async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ─── tmpdir lifecycle: every repo cleaned up after its test ─────────────────
const repos: RealGitRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});
const track = <R extends RealGitRepo>(r: R): R => {
  repos.push(r);
  return r;
};

// ─── 1) commit-lands ────────────────────────────────────────────────────────
describe("autocommit real-git: 1) commit-lands", () => {
  it("a write + message_end lands a NEW commit with the fixed message containing MEMORY.md", async () => {
    const repo = track(createRealGitRepo());
    const { pi, handlers } = createMockPi();
    setup(repo, pi);

    const before = repo.logCount();
    repo.appendMemoryEntries("learned: opt-in autocommit commits memory");
    emitMessageEnd(handlers);

    await waitFor(() => (repo.logCount() > before ? true : undefined));
    const sha = repo.head();

    assert.strictEqual(repo.commitSubject(sha), AUTOCOMMIT_COMMIT_MESSAGE, "fixed conventional-commit message");
    assert.deepStrictEqual(repo.commitFiles(sha), [repo.memoryRelPath], "the commit contains only MEMORY.md");
  });
});

// ─── 2) no-sweep (the safety guarantee — highest value) ─────────────────────
describe("autocommit real-git: 2) no-sweep (safety guarantee)", () => {
  it("a pre-staged UNRELATED file is NOT swept into the autocommit (stays staged-but-uncommitted)", async () => {
    const repo = track(createRealGitRepo());
    const { pi, handlers } = createMockPi();
    setup(repo, pi);

    // Pre-stage an unrelated file BEFORE triggering — the exact thing mocks can't reach.
    fs.writeFileSync(path.join(repo.cwd, "scratch.txt"), "unrelated staged content\n");
    repo.run(["add", "--", "scratch.txt"]);
    assert.deepStrictEqual(repo.stagedFiles(), ["scratch.txt"], "scratch.txt is staged before the trigger");

    const before = repo.logCount();
    repo.appendMemoryEntries("a fresh memory entry");
    emitMessageEnd(handlers);

    await waitFor(() => (repo.logCount() > before ? true : undefined));
    const sha = repo.head();

    // The autocommit contains ONLY MEMORY.md (the explicit `-- <relPath>` pathspec).
    assert.deepStrictEqual(repo.commitFiles(sha), [repo.memoryRelPath], "autocommit touches only MEMORY.md");
    assert.ok(repo.stagedFiles().includes("scratch.txt"), "the unrelated file must REMAIN staged (not swept in)");
  });
});

// ─── 3) branch-switch ───────────────────────────────────────────────────────
describe("autocommit real-git: 3) branch-switch", () => {
  it("the autocommit lands on the feature branch and NOT on the base branch", async () => {
    const repo = track(createRealGitRepo({ featureBranch: "feature/durable" }));
    const { pi, handlers } = createMockPi();
    setup(repo, pi);

    const baseBranch = "main";
    const before = repo.logCount();
    repo.appendMemoryEntries("branch-scoped memory");
    emitMessageEnd(handlers);

    await waitFor(() => (repo.logCount() > before ? true : undefined));
    const sha = repo.head();

    const contains = repo.branchesContaining(sha);
    assert.ok(contains.includes("feature/durable"), "the commit is on the feature branch");
    assert.ok(!contains.includes(baseBranch), "the commit is NOT on the base branch");

    // Switching back to the base branch hides the autocommit's MEMORY.md edit.
    repo.run(["checkout", "-q", baseBranch]);
    assert.ok(
      !repo.readMemory().includes("branch-scoped memory"),
      "the base branch does not see the feature-branch memory",
    );
  });
});

// ─── 4) §-union merge driver (git-level only — decision 01 = A) ──────────────
describe("autocommit real-git: 4) §-union merge driver (git-level)", () => {
  it("a real two-branch merge unions BOTH appends; common base is not duplicated", () => {
    // Pure git-level: hook not involved in the merge (07 owns the .md→DB re-sync).
    const repo = track(
      createRealGitRepo({
        initialMemoryEntries: ["Base entry alpha", "Base entry bravo"],
        configureMergeDriver: true,
        featureBranch: null, // stay on main; create branches manually below
      }),
    );

    // Branch A appends a distinct entry.
    repo.run(["checkout", "-q", "-b", "feature/alpha"]);
    repo.appendMemoryEntries("Alpha-only entry");
    repo.run(["add", "--", repo.memoryRelPath]);
    repo.run(["commit", "-q", "-m", "memory: alpha entry"]);

    // Back on main; append a DIFFERENT entry (both diverge from the common base).
    repo.run(["checkout", "-q", "main"]);
    repo.appendMemoryEntries("Bravo-only entry");
    repo.run(["add", "--", repo.memoryRelPath]);
    repo.run(["commit", "-q", "-m", "memory: bravo entry"]);

    // Merge A into main → git invokes the §-union driver for MEMORY.md.
    repo.run(["merge", "--no-edit", "feature/alpha"]);

    const merged = repo.readMemory();
    const entries = merged.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);

    assert.ok(entries.includes("Base entry alpha"), "common base alpha survives the merge");
    assert.ok(entries.includes("Base entry bravo"), "common base bravo survives the merge");
    assert.ok(entries.includes("Alpha-only entry"), "the alpha-side append survives");
    assert.ok(entries.includes("Bravo-only entry"), "the bravo-side append survives");
    assert.strictEqual(
      entries.filter((e) => e === "Base entry alpha").length,
      1,
      "common-base entry appears exactly once (dedup'd by the union)",
    );
    assert.ok(!merged.includes("<<<<<<<"), "no conflict markers — the driver produced a clean union");
  });
});

// ─── 5) abort-skip ──────────────────────────────────────────────────────────
describe("autocommit real-git: 5) abort-skip", () => {
  it("a real mid-merge state (MERGE_HEAD) skips cleanly — no commit, no corrupt commit", async () => {
    const repo = track(createRealGitRepo());
    const { pi, handlers } = createMockPi();
    setup(repo, pi);

    // Real mid-merge sentinel (the hook's isMidMerge checks file existence).
    fs.writeFileSync(path.join(repo.gitDir, "MERGE_HEAD"), `${"0".repeat(40)}\n`);

    const before = repo.logCount();
    repo.appendMemoryEntries("should-not-commit-while-mid-merge");
    emitMessageEnd(handlers);

    await settle(); // the debounce fires + the cycle runs → skip (no re-arm)
    assert.strictEqual(repo.logCount(), before, "no new commit while a merge is in progress");
  });

  it("a real index.lock defers (no commit, no throw) and re-arms one debounce tick", async () => {
    const repo = track(createRealGitRepo());
    // index.lock present → the hook's isIndexLocked sees it → classify returns "defer".
    fs.writeFileSync(path.join(repo.gitDir, "index.lock"), "");

    const before = repo.logCount();

    // Fake timers + REAL runCommitCycle (default): deterministic, no infinite
    // real-timer re-arm loop. The value under test is real git, not real timers.
    let pending: (() => void) | null = null;
    const { pi, handlers } = createMockPi();
    setup(repo, pi, {
      scheduleTimer: (cb: () => void) => {
        pending = cb;
        return 1;
      },
      clearTimer: () => {
        pending = null;
      },
    });

    repo.appendMemoryEntries("should-defer-on-index-lock");
    emitMessageEnd(handlers);
    assert.ok(pending !== null, "the debounce scheduled a fire");

    // Flush → real runCommitCycle runs against real git, sees index.lock → "defer".
    const fire = pending!;
    pending = null;
    fire();
    // Poll for the re-arm instead of a fixed settle window: the cycle spawns a
    // REAL git subprocess, and a fixed 120 ms was not always enough under
    // CI-machine load (local_ci runs this suite beside the 4-wide package test
    // phase + the gate pool — observed red twice on 2026-08-23, green in every
    // standalone run). A 5 s DEADLINE bounds a hang while tolerating any
    // real-world latency; the assertion itself is unchanged.
    const deadline = Date.now() + 5_000;
    while (pending === null && Date.now() < deadline) {
      await settle(25);
    }

    assert.strictEqual(repo.logCount(), before, "no commit while the index is locked (deferred, not skipped)");
    assert.ok(pending !== null, "a defer re-arms one more debounce tick (transient contention retries)");
  });
});
