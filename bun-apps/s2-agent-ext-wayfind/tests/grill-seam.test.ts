// tests/grill-seam.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { WAYFIND_GRILL_KEY } from "../src/constants.js";
import { publishWayfindGrill, readWayfindGrill, unpublishWayfindGrill } from "../src/coordination.js";
import { createRuntimeState } from "../src/state.js";

beforeEach(() => {
  delete (globalThis as any)[WAYFIND_GRILL_KEY];
});
afterEach(() => {
  delete (globalThis as any)[WAYFIND_GRILL_KEY];
});

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

test("grill seam is false for a wayfinder-only session (no grill)", () => {
  const state = createRuntimeState();
  publishWayfindGrill(state);
  // wayfinder-only (no grill) → grill seam false
  state.activeEffortBySession.set("sess-1", "big-effort");
  expect(readWayfindGrill("sess-1")).toBe(false);
});

test("unpublishWayfindGrill clears the global", () => {
  const state = createRuntimeState();
  publishWayfindGrill(state);
  unpublishWayfindGrill();
  expect(readWayfindGrill("sess-1")).toBe(false);
});
