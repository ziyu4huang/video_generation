/**
 * Unit tests for the pure §-union merge function (autocommit-hook effort,
 * ticket 05). The merge driver splits MEMORY.md on `§` (ENTRY_DELIMITER),
 * unions entries by trimmed content (dedup), and rejoins — so two branches
 * that each appended entries both survive and common base entries aren't
 * duplicated. True edit-conflicts (same entry changed on both sides) keep
 * both versions.
 *
 * These tests exercise the PURE function only (no git, no filesystem).
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { unionMemoryEntries } from "../src/merge-union.js";
import { ENTRY_DELIMITER } from "../src/constants.js";

const D = ENTRY_DELIMITER; // "\n§\n"

describe("unionMemoryEntries (pure §-union merge, ticket 05)", () => {
  it("unions entries appended on both sides; base entries appear once", () => {
    const base = ["alpha", "beta"].join(D);
    const ours = ["alpha", "beta", "gamma"].join(D); // ours appended gamma
    const theirs = ["alpha", "beta", "delta"].join(D); // theirs appended delta
    const merged = unionMemoryEntries(base, ours, theirs);
    assert.strictEqual(
      merged,
      ["alpha", "beta", "gamma", "delta"].join(D),
      "base entries first, then ours-new, then theirs-new",
    );
  });

  it("dedupes entries that both sides added identically", () => {
    const base = ["x", "y"].join(D);
    const ours = ["x", "y", "z"].join(D);
    const theirs = ["x", "y", "z"].join(D); // both added the same z
    const merged = unionMemoryEntries(base, ours, theirs);
    assert.strictEqual(merged, ["x", "y", "z"].join(D), "z appears exactly once");
  });

  it("keeps BOTH versions on a true edit-conflict (same slot, different text)", () => {
    const base = "same";
    const ours = ["same", "ours-version"].join(D);
    const theirs = ["same", "theirs-version"].join(D);
    const merged = unionMemoryEntries(base, ours, theirs);
    assert.strictEqual(
      merged,
      ["same", "ours-version", "theirs-version"].join(D),
      "both conflicting versions survive (consolidation merges them later)",
    );
  });

  it("dedupes by TRIMMED content (whitespace-only differences collapse)", () => {
    const base = "  spaced  ";
    const ours = "spaced"; // same after trim
    const theirs = "";
    const merged = unionMemoryEntries(base, ours, theirs);
    assert.strictEqual(merged, "spaced", "trimmed-equal entries dedupe to one");
  });

  it("returns the empty string when all three sides are empty", () => {
    assert.strictEqual(unionMemoryEntries("", "", ""), "");
  });

  it("handles a side that deleted an entry (union keeps it — never loses data)", () => {
    // base has [a, b]; ours deleted b → [a]; theirs kept [a, b].
    // Union is additive: b survives because theirs still has it.
    const base = ["a", "b"].join(D);
    const ours = "a";
    const theirs = ["a", "b"].join(D);
    const merged = unionMemoryEntries(base, ours, theirs);
    assert.strictEqual(merged, ["a", "b"].join(D));
  });

  it("preserves first-seen order: base, then ours-only, then theirs-only", () => {
    const base = ["base1", "base2"].join(D);
    const ours = ["base1", "base2", "ours1", "ours2"].join(D);
    const theirs = ["base1", "base2", "theirs1"].join(D);
    const merged = unionMemoryEntries(base, ours, theirs);
    assert.strictEqual(
      merged,
      ["base1", "base2", "ours1", "ours2", "theirs1"].join(D),
    );
  });

  it("skips blank entries produced by a trailing delimiter", () => {
    const base = "a" + D + D; // trailing empty entry after delimiter
    const ours = "a";
    const theirs = "a";
    const merged = unionMemoryEntries(base, ours, theirs);
    assert.strictEqual(merged, "a", "blank entries are dropped");
  });

  it("is deterministic / idempotent: re-merging the result is a no-op", () => {
    const base = ["a", "b"].join(D);
    const ours = ["a", "b", "c"].join(D);
    const theirs = ["a", "b", "d"].join(D);
    const merged = unionMemoryEntries(base, ours, theirs);
    // Re-merge with merged on all three sides → unchanged.
    const reMerged = unionMemoryEntries(merged, merged, merged);
    assert.strictEqual(reMerged, merged);
  });

  it("honors a custom delimiter", () => {
    const delim = "\n---\n";
    const base = "a" + delim + "b";
    const ours = "a" + delim + "b" + delim + "c";
    const theirs = "a" + delim + "b";
    const merged = unionMemoryEntries(base, ours, theirs, { delimiter: delim });
    assert.strictEqual(merged, ["a", "b", "c"].join(delim));
  });
});
