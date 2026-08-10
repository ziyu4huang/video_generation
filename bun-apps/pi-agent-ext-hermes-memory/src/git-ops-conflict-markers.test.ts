// Focused test for the pure conflict-marker scan added in 09-impl T5.
// `hasMergeConflictMarkers` is a FILE-CONTENT signal (per-file), deliberately
// distinct from `GitOps.isMidMerge` (REPO-STATE — sentinel files in `.git/`).
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { hasMergeConflictMarkers } from "./git-ops.js";

describe("hasMergeConflictMarkers", () => {
  it("flags a full conflict-marker block", () => {
    const md = "# 08 — x\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n";
    assert.equal(hasMergeConflictMarkers(md), true);
  });
  it("flags a lone opening marker (mid-resolution)", () => {
    assert.equal(hasMergeConflictMarkers("<<<<<<< HEAD\nbody"), true);
  });
  it("flags a whole-line ======= divider even without <<< / >>>", () => {
    // A bare `=======` on its own line is a real git divider even when the
    // opening/closing markers were already resolved and deleted.
    assert.equal(hasMergeConflictMarkers("# t\nours\n=======\ntheirs\n"), true);
  });
  it("does NOT flag normal md that merely contains seven chars", () => {
    // '=======' on its own line is a conflict divider, but the word "conflict"
    // or a horizontal-rule in body text must NOT trip a false positive.
    assert.equal(hasMergeConflictMarkers("# title\n\nsome ======= text here\n"), false);
    assert.equal(hasMergeConflictMarkers("---\nstatus: active\n---\n# map\n"), false);
  });
  it("is false for clean planning md", () => {
    assert.equal(hasMergeConflictMarkers("# 08 — x\n\n## Resolution\nClean.\n"), false);
  });
});
