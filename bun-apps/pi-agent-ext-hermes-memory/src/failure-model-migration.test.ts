import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ENTRY_DELIMITER } from "./constants.js";
import { canonicalizeFailureBacklog } from "./failure-model-migration.js";

function fm(id: string, body: string, created: string, last: string, state?: string): string {
  const fmLines = ["---", `id: ${id}`, `created: ${created}`, `last: ${last}`];
  if (state) fmLines.push(`state: ${state}`);
  fmLines.push("---", body);
  return fmLines.join("\n");
}

test("dry-run compresses resolved and keeps unique lessons", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-mig-"));
  const failuresPath = path.join(dir, "failures.md");
  const entries = [
    fm("a", "[tool-quirk] `await_pr_merge` blocks merge until CI green — pre #1030 hazard", "2026-08-02", "2026-08-02"),
    fm("b", "[tool-quirk] `await_pr_merge` blocks merge until CI green — pre #1030 hazard", "2026-08-02", "2026-08-02"),
    fm("c", "[tool-quirk] `await_pr_merge` cross-worktree #1028 incident details here", "2026-08-03", "2026-08-03"),
    fm("d", "[tool-quirk] `await_pr_merge` now merges directly once CI green (post #1030) — resolved", "2026-08-04", "2026-08-04", "resolved"),
    fm("e", "[insight] unrelated unique lesson about mlx bfloat16 dtype handling", "2026-08-01", "2026-08-01"),
  ];
  fs.writeFileSync(failuresPath, entries.join(ENTRY_DELIMITER), "utf-8");

  const result = canonicalizeFailureBacklog({ failuresPath, dryRun: true });

  expect(result.scanned).toBe(5);
  expect(result.diff).toContain("unrelated unique lesson about mlx");
  expect(result.dropped + result.compressed).toBeGreaterThan(0);
  expect(fs.readFileSync(failuresPath, "utf-8")).toBe(entries.join(ENTRY_DELIMITER));
});

test("apply writes a smaller file and produces a backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-mig-"));
  const failuresPath = path.join(dir, "failures.md");
  const original = [
    fm("a", "[tool-quirk] `await_pr_merge` first capture here", "2026-08-02", "2026-08-02"),
    // Ticket 06 removed near-dup/topic-key collapse, so the shrink invariant is
    // compression alone: a long resolved entry compresses to a one-line fact
    // vs its uncompressed baseline (a one-line entry compresses to equal length).
    fm(
      "b",
      "[tool-quirk] `await_pr_merge` second capture with several sentences of incident detail — " +
        "the merge waited on remote CI, blocked the branch for hours, and needed a manual squash " +
        "fallback to unblock. Now resolved after #1030 landed.",
      "2026-08-03",
      "2026-08-03",
      "resolved",
    ),
  ].join(ENTRY_DELIMITER);
  fs.writeFileSync(failuresPath, original, "utf-8");

  const result = canonicalizeFailureBacklog({ failuresPath, dryRun: false, backup: true });
  const after = fs.readFileSync(failuresPath, "utf-8");
  expect(result.compressed).toBe(1);
  expect(after.length).toBeLessThan(original.length);
  expect(fs.existsSync(failuresPath + ".bak")).toBe(true);
  expect(fs.readFileSync(failuresPath + ".bak", "utf-8")).toBe(original);
});

test("active unique entries with different subjects are never trimmed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-mig-"));
  const failuresPath = path.join(dir, "failures.md");
  const entries = [
    fm("a", "[insight] bun install caches offline packages in global store", "2026-08-01", "2026-08-01"),
    fm("b", "[insight] mlx array conversions require contiguous memory layout", "2026-08-02", "2026-08-02"),
  ].join(ENTRY_DELIMITER);
  fs.writeFileSync(failuresPath, entries, "utf-8");

  const result = canonicalizeFailureBacklog({ failuresPath, dryRun: true });
  expect(result.dropped).toBe(0);
});
