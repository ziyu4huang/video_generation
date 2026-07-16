// tests/grill-seam.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createRuntimeState } from "../src/state.js";
import { publishWayfindGrill, unpublishWayfindGrill, readWayfindGrill, isWayfindActivePublished, publishWayfindActive } from "../src/coordination.js";
import { WAYFIND_GRILL_KEY } from "../src/constants.js";

beforeEach(() => { delete (globalThis as any)[WAYFIND_GRILL_KEY]; });
afterEach(() => { delete (globalThis as any)[WAYFIND_GRILL_KEY]; });

test("readWayfindGrill returns false when no seam published", () => {
  expect(readWayfindGrill("sess-1")).toBe(false);
});

test("publishWayfindGrill exposes a per-session grill-active reader", () => {
  const state = createRuntimeState();
  publishWayfindGrill(state);
  state.activeGrillBySession.set("sess-1", "auth redesign");
  state.activeGrillBySession.set("sess-2", "(current conversation)");
  expect(readWayfindGrill("sess-1")).toBe(true);
  expect(readWayfindGrill("sess-2")).toBe(true);
  expect(readWayfindGrill("sess-3")).toBe(false); // no grill for this session
});

test("grill seam is independent of the wayfinder boolean seam", () => {
  const state = createRuntimeState();
  publishWayfindGrill(state);
  publishWayfindActive(state);
  // wayfinder-only (no grill) → boolean seam true, grill seam false
  state.activeEffortBySession.set("sess-1", "big-effort");
  expect(isWayfindActivePublished()).toBe(true);
  expect(readWayfindGrill("sess-1")).toBe(false);
});

test("unpublishWayfindGrill clears the global", () => {
  const state = createRuntimeState();
  publishWayfindGrill(state);
  unpublishWayfindGrill();
  expect(readWayfindGrill("sess-1")).toBe(false);
});
