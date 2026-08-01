import { test, expect } from "bun:test";
import {
  hashEntry,
  snapshotBaseHash,
  mergePlanValidate,
  buildSnapshot,
  applyMergePlan,
  parseEntry,
  type MergePlan,
} from "./merge-plan.js";

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

const E = (c: string, created = "2026-08-01", last = "2026-08-01") =>
  `${c}\n<!-- created=${created}, last=${last} -->`;

test("buildSnapshot hashes each entry, strips content, totals chars", () => {
  const enc = [E("alpha"), E("beta")];
  const snap = buildSnapshot("failure", enc, 40_000);
  expect(snap.entries).toHaveLength(2);
  expect(snap.entries[0].key).toBe(hashEntry(enc[0]));
  expect(snap.entries[0].content).toBe("alpha");
  expect(snap.totalChars).toBe(enc.join("\n§\n").length);
  expect(snap.charLimit).toBe(40_000);
  expect(snap.snapshotBaseHash).toBe(snapshotBaseHash(enc));
});

test("applyMergePlan: drop removes a present entry", () => {
  const enc = [E("alpha"), E("beta")];
  const plan: MergePlan = { snapshotBaseHash: snapshotBaseHash(enc), ops: [{ op: "drop", key: hashEntry(enc[0]) }] };
  const r = applyMergePlan(enc, plan);
  expect(r.applied).toHaveLength(1);
  expect(r.skipped).toHaveLength(0);
  expect(r.entries.map(parseEntry).map((e) => e.content)).toEqual(["beta"]);
});

test("applyMergePlan: merge replaces N present entries with one new", () => {
  const enc = [E("alpha"), E("beta"), E("gamma")];
  const plan: MergePlan = {
    snapshotBaseHash: snapshotBaseHash(enc),
    ops: [{ op: "merge", fromKeys: [hashEntry(enc[0]), hashEntry(enc[1])], content: "alpha+beta" }],
  };
  const r = applyMergePlan(enc, plan);
  const contents = r.entries.map(parseEntry).map((e) => e.content);
  expect(contents).toContain("alpha+beta");
  expect(contents).not.toContain("alpha");
  expect(contents).not.toContain("beta");
  expect(contents).toContain("gamma");
});

test("applyMergePlan: merge with a vanished fromKey skips the WHOLE merge", () => {
  const enc = [E("alpha"), E("beta")]; // 'gamma' fromKey is gone
  const plan: MergePlan = {
    snapshotBaseHash: "mismatch",
    ops: [{ op: "merge", fromKeys: [hashEntry(enc[0]), hashEntry(E("gamma"))], content: "x" }],
  };
  const r = applyMergePlan(enc, plan);
  expect(r.skipped).toHaveLength(1);
  expect(r.applied).toHaveLength(0);
  expect(r.entries.map(parseEntry).map((e) => e.content)).toEqual(["alpha", "beta"]);
});

test("applyMergePlan: appended entry (not in snapshot) is preserved", () => {
  const enc = [E("alpha"), E("beta"), E("NEW-APPEND")];
  const plan: MergePlan = {
    snapshotBaseHash: snapshotBaseHash([E("alpha"), E("beta")]),
    ops: [{ op: "drop", key: hashEntry(E("alpha")) }],
  };
  const r = applyMergePlan(enc, plan);
  const contents = r.entries.map(parseEntry).map((e) => e.content);
  expect(contents).toEqual(["beta", "NEW-APPEND"]);
  expect(r.baseHashMatched).toBe(false);
});

test("applyMergePlan: base-hash match flags the fast path", () => {
  const enc = [E("alpha"), E("beta")];
  const plan: MergePlan = { snapshotBaseHash: snapshotBaseHash(enc), ops: [{ op: "drop", key: hashEntry(enc[0]) }] };
  const r = applyMergePlan(enc, plan);
  expect(r.baseHashMatched).toBe(true);
});
