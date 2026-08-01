import { test, expect } from "bun:test";
import { hashEntry, snapshotBaseHash, mergePlanValidate, type MergePlan } from "./merge-plan.js";

test("hashEntry is deterministic and content-sensitive", () => {
  const a = "some memory\n<!-- created=2026-08-01, last=2026-08-01 -->";
  expect(hashEntry(a)).toBe(hashEntry(a));
  expect(hashEntry(a)).not.toBe(hashEntry(a + " "));
  expect(hashEntry(a)).toMatch(/^[0-9a-f]{16}$/);
});

test("snapshotBaseHash is order-insensitive and change-sensitive", () => {
  const e1 = "alpha\n<!-- created=2026-08-01, last=2026-08-01 -->";
  const e2 = "beta\n<!-- created=2026-08-01, last=2026-08-01 -->";
  expect(snapshotBaseHash([e1, e2])).toBe(snapshotBaseHash([e2, e1]));
  expect(snapshotBaseHash([e1, e2])).not.toBe(snapshotBaseHash([e1, e2, e2]));
});

test("mergePlanValidate accepts a well-formed plan and rejects malformed", () => {
  const plan: MergePlan = {
    snapshotBaseHash: "abc123",
    ops: [
      { op: "drop", key: "0123456789abcdef" },
      { op: "merge", fromKeys: ["0123456789abcdef", "fedcba9876543210"], content: "merged" },
    ],
  };
  expect(() => mergePlanValidate(plan)).not.toThrow();
  // malformed: merge missing content
  const bad: unknown = { snapshotBaseHash: "x", ops: [{ op: "merge", fromKeys: ["a"] /* no content */ }] };
  expect(() => mergePlanValidate(bad)).toThrow();
});
