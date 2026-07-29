// tests/watchdog-repo-diff.test.ts
//
// Hermetic: injects a mock RepoGitOps with canned porcelain-z output so NO
// host `git` binary is spawned (no direct subprocess calls from the test). This keeps the test
// deterministic across environments and passes the test-portability audit
// (the git seam is GUARDED behind an injection point — production uses
// realRepoGitOps, the test injects a mock).

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedTsJsPaths, computeBaseline, diffTextForReview, type RepoGitOps } from "../src/watchdog/repo-diff.js";

/**
 * Build a mock RepoGitOps. `status`/`diff`/`ls` are the canned return values;
 * every git operation is now a pure lookup, never a subprocess.
 *
 * Canned porcelain-z format reminder (see parsePorcelainZ): each entry is
 * `XY <path>` NUL-separated — 2-char status code, a space, then the path
 * (path = token.slice(3)). Untracked = `??`, worktree-modified = ` M`.
 */
function mockGitOps(opts: { status: string; diff?: string; lsFiles?: string; root?: string }): RepoGitOps {
  const root = opts.root ?? "/fake/repo-root";
  return {
    toplevel: () => root,
    statusPorcelainAll: () => opts.status,
    diffHead: (_cwd, _paths) => opts.diff,
    lsFiles: () => opts.lsFiles ?? "",
  };
}

describe("repo-diff (hermetic — mock RepoGitOps)", () => {
  it("edit-gate: identical canned status → identical signature key", () => {
    // Two calls with byte-identical canned porcelain must yield identical keys.
    const gitOps = mockGitOps({ status: " M a.ts\0" });
    const a = computeBaseline("/cwd", gitOps);
    const b = computeBaseline("/cwd", gitOps);
    assert.ok(a, "baseline must exist");
    assert.ok(b, "baseline must exist");
    assert.equal(a.key, b.key);
  });

  it("signature changes + changedTsJsPaths lists a new TS file", () => {
    // before: one modified tracked file. after: + an untracked impl.ts.
    const before = computeBaseline("/cwd", mockGitOps({ status: " M a.ts\0" }));
    assert.ok(before, "baseline must exist");
    const after = computeBaseline("/cwd", mockGitOps({ status: " M a.ts\0?? impl.ts\0" }));
    assert.ok(after, "baseline must exist");
    assert.notEqual(before.key, after.key);
    assert.ok(changedTsJsPaths(before, after).includes("impl.ts"));
  });

  it("diffTextForReview includes the new file content", () => {
    // Mock diffHead returns a diff containing the new symbol; lsFiles empty so
    // impl.ts is treated as untracked (its raw read is skipped — file absent —
    // leaving the diff body as the only contributor to the review text).
    const gitOps = mockGitOps({
      status: "?? impl.ts\0",
      diff: "diff --git a/impl.ts b/impl.ts\n+export const x = 1;\n",
      lsFiles: "",
    });
    const txt = diffTextForReview("/cwd", ["impl.ts"], gitOps);
    assert.match(txt, /export const x = 1/);
  });
});
