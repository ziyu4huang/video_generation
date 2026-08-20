import { test, expect } from "bun:test";
import {
  hashEntry,
  snapshotBaseHash,
  mergePlanValidate,
  buildSnapshot,
  applyMergePlan,
  parseEntry,
  NEUTRAL_HEAT,
  type MergePlan,
} from "./merge-plan.js";
import { serializeMetadataFrontmatter } from "./memory-format.js";

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

// ─── Task 5: consolidator snapshot heat-sort (baseHash-safe, prompt-free) ───
// buildSnapshot gains an optional `heats` Map; when present, snapshot.entries
// are ordered lowest-heat-first (a positional nudge for the LLM — no prompt
// change). snapshotBaseHash is order-insensitive so the reconcile-write is
// unaffected (the critical assertion below). NEUTRAL_HEAT (0.5) places entries
// whose mdId is missing/absent neutrally.

/** Frontmatter entry with a known stable id (so heats Map keys align). */
const FM = (id: string, body: string) =>
  serializeMetadataFrontmatter({ id, text: body, created: "2026-08-01", last: "2026-08-01" });

test("NEUTRAL_HEAT is 0.5 (the documented neutral placement value)", () => {
  expect(NEUTRAL_HEAT).toBe(0.5);
});

test("parseEntry surfaces mdId from frontmatter and undefined for comment-shape", () => {
  const fm = parseEntry(FM("m1", "alpha"));
  expect(fm.mdId).toBe("m1");
  expect(fm.content).toBe("alpha");
  const comment = parseEntry(E("legacy no id"));
  expect(comment.mdId).toBeUndefined();
  expect(comment.content).toBe("legacy no id");
});

test("buildSnapshot: with heats, entries are ordered lowest-heat-first", () => {
  const enc = [FM("m-hot", "HOT body"), FM("m-cold", "COLD body"), FM("m-warm", "WARM body")];
  const heats = new Map([["m-hot", 0.9], ["m-cold", 0.1], ["m-warm", 0.5]]);
  const snap = buildSnapshot("memory", enc, 40_000, heats);
  expect(snap.entries.map((e) => e.content)).toEqual(["COLD body", "WARM body", "HOT body"]);
});

test("buildSnapshot: WITHOUT heats, entry order is unchanged (disable-path parity)", () => {
  const enc = [FM("m-hot", "HOT body"), FM("m-cold", "COLD body"), FM("m-warm", "WARM body")];
  // No heats arg at all → preserve parse order (byte-identical to pre-Task-5).
  const omitted = buildSnapshot("memory", enc, 40_000);
  expect(omitted.entries.map((e) => e.content)).toEqual(["HOT body", "COLD body", "WARM body"]);
  // Explicitly undefined MUST behave identically to omitted (the disable path).
  const explicitUndefined = buildSnapshot("memory", enc, 40_000, undefined);
  expect(explicitUndefined.entries.map((e) => e.content)).toEqual(["HOT body", "COLD body", "WARM body"]);
});

test("buildSnapshot: equal-heat entries keep their parse order (stable tiebreak)", () => {
  const enc = [FM("m-a", "A body"), FM("m-b", "B body"), FM("m-c", "C body")];
  const heats = new Map([["m-a", 0.5], ["m-b", 0.5], ["m-c", 0.5]]); // all equal
  const snap = buildSnapshot("memory", enc, 40_000, heats);
  expect(snap.entries.map((e) => e.content)).toEqual(["A body", "B body", "C body"]);
});

test("buildSnapshot: entries with missing/absent mdId place at NEUTRAL heat between lower and higher", () => {
  // legacy (comment-shape → no mdId) and m-absent (mdId present but not in the
  // heats Map) both fall back to NEUTRAL_HEAT (0.5); they place between the
  // lower-heat (cold 0.1) and higher-heat (hot 0.9) entries, keeping parse
  // order among themselves.
  const enc = [E("LEGACY no id"), FM("m-cold", "COLD body"), FM("m-absent", "ABSENT body"), FM("m-hot", "HOT body")];
  const heats = new Map([["m-cold", 0.1], ["m-hot", 0.9]]); // legacy + m-absent absent
  const snap = buildSnapshot("memory", enc, 40_000, heats);
  // ascending: cold(0.1) → [legacy(0.5), absent(0.5) stable] → hot(0.9)
  expect(snap.entries.map((e) => e.content)).toEqual(["COLD body", "LEGACY no id", "ABSENT body", "HOT body"]);
});

test("snapshotBaseHash is IDENTICAL regardless of heat-sort (the critical reconcile safety property)", () => {
  const enc = [FM("m-hot", "HOT body"), FM("m-cold", "COLD body"), FM("m-warm", "WARM body")];
  const heatsAsc = new Map([[
    "m-hot", 0.9], ["m-cold", 0.1], ["m-warm", 0.5]]);
  const heatsDesc = new Map([["m-hot", 0.1], ["m-cold", 0.9], ["m-warm", 0.5]]); // reverses the sort
  const noHeats = buildSnapshot("memory", enc, 40_000);
  const withHeats = buildSnapshot("memory", enc, 40_000, heatsAsc);
  const withReversedHeats = buildSnapshot("memory", enc, 40_000, heatsDesc);
  // All three MUST share the same baseHash — sorting entries cannot change it.
  expect(noHeats.snapshotBaseHash).toBe(withHeats.snapshotBaseHash);
  expect(noHeats.snapshotBaseHash).toBe(withReversedHeats.snapshotBaseHash);
  // And it equals the direct order-insensitive snapshotBaseHash over the raw set.
  expect(noHeats.snapshotBaseHash).toBe(snapshotBaseHash(enc));
  // Sanity: the two heat orderings DO produce different entry orders (so this
  // is not a vacuous assertion).
  expect(withHeats.entries.map((e) => e.content)).not.toEqual(withReversedHeats.entries.map((e) => e.content));
});
