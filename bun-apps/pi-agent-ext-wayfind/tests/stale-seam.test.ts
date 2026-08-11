// tests/stale-seam.test.ts — wayfind READER of hermes's staleness reverse seam (T7).
//
// bun:test (mirrors tests/grill-seam.test.ts). The reader is null-safe: returns
// null when hermes is absent (no seam) OR when the published fn throws, so the
// T8 graduation gate degrades to a no-op and NEVER crashes.
import { afterEach, expect, test } from "bun:test";
import { readStaleDecisions } from "../src/stale-seam.js";

const KEY = "__piHermesStaleCheck";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[KEY];
});

test("readStaleDecisions returns null when no seam published (hermes absent)", async () => {
  expect(await readStaleDecisions("eff", "/cwd")).toBeNull();
});

test("readStaleDecisions returns the stale list when hermes published it", async () => {
  (globalThis as Record<string, unknown>)[KEY] = async (_effort: string, _cwd: string) => ({
    stale: [{ cardId: "planning-ticket:e:01", effort: "e" }],
  });
  const r = await readStaleDecisions("e", "/cwd");
  expect(r).toEqual([{ cardId: "planning-ticket:e:01", effort: "e" }]);
});

test("readStaleDecisions degrades to null when the seam throws (never crashes the gate)", async () => {
  (globalThis as Record<string, unknown>)[KEY] = async () => {
    throw new Error("boom");
  };
  expect(await readStaleDecisions("e", "/cwd")).toBeNull();
});

test("readStaleDecisions degrades to null when the seam returns no stale field", async () => {
  (globalThis as Record<string, unknown>)[KEY] = async () => ({});
  expect(await readStaleDecisions("e", "/cwd")).toBeNull();
});
