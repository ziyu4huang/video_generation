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
function mockGitOps(opts: {
  status: string;
  diff?: string;
  /** Path-aware diff: when set, diffHead returns only the hunks for requested paths. */
  diffByPath?: Record<string, string>;
  lsFiles?: string;
  root?: string;
}): RepoGitOps {
  const root = opts.root ?? "/fake/repo-root";
  return {
    toplevel: () => root,
    statusPorcelainAll: () => opts.status,
    diffHead: (_cwd, paths) =>
      opts.diffByPath
        ? paths
            .map((p) => opts.diffByPath[p] ?? "")
            .filter(Boolean)
            .join("\n")
        : opts.diff,
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
    const result = diffTextForReview("/cwd", ["impl.ts"], gitOps);
    assert.match(result.text, /export const x = 1/);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.droppedNoiseFiles, []);
  });

  it("diffTextForReview drops lockfile noise, keeps code, flags truncated", () => {
    // Conservative noise filter (ticket 04): lockfiles/generated are dropped from
    // the path set before diffing; real code is kept; truncation is flagged when
    // anything is dropped. diffByPath makes the mock path-aware so the filter is
    // observable (a path-ignoring mock could not prove exclusion).
    const gitOps = mockGitOps({
      status: " M impl.ts\0 M package-lock.json\0",
      lsFiles: "impl.ts\npackage-lock.json\n",
      diffByPath: {
        "impl.ts": "diff --git a/impl.ts b/impl.ts\n+export const x = 1;\n",
        "package-lock.json": "diff --git a/package-lock.json b/package-lock.json\n+LOCKNOISE\n",
      },
    });
    const result = diffTextForReview("/cwd", ["impl.ts", "package-lock.json"], gitOps);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.droppedNoiseFiles, ["package-lock.json"]);
    assert.match(result.text, /export const x = 1/);
    assert.doesNotMatch(result.text, /LOCKNOISE/);
  });

  it("diffTextForReview applies per-file budget, flags truncated files", () => {
    // Ticket 04 per-file budget: each file gets a fair share (budget/N, floored);
    // files exceeding their share are head-capped and listed in truncatedFiles.
    // Tiny maxBytes (4th arg) makes this observable without a 200KB fixture.
    const big = (label: string) => `diff --git a/${label} b/${label}\n+${"x".repeat(2000)}\n`;
    const gitOps = mockGitOps({
      status: " M a.ts\0 M b.ts\0",
      lsFiles: "a.ts\nb.ts\n",
      diffByPath: { "a.ts": big("a.ts"), "b.ts": big("b.ts") },
    });
    const result = diffTextForReview("/cwd", ["a.ts", "b.ts"], gitOps, 2000);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.truncatedFiles.sort(), ["a.ts", "b.ts"]);
    assert.ok(result.text.length <= 2000, `text within budget: ${result.text.length}`);
  });
});
