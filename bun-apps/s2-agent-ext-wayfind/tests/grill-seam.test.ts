// tests/grill-seam.test.ts — publish-side contract only. wayfind no longer
// ships its own reader (`readWayfindGrill` removed 2026-08-22: hermes-memory,
// the seam's only consumer, carries its own reader at src/grill-seam.ts); these
// tests read the global directly, exactly like hermes-memory does.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { WAYFIND_GRILL_KEY } from "../src/constants.js";
import { publishWayfindGrill, unpublishWayfindGrill } from "../src/coordination.js";
import { createRuntimeState } from "../src/state.js";

/** Read the published seam the way hermes-memory's grill-seam.ts does. */
function readSeam(sessionId: string): boolean {
  const fn = (globalThis as Record<string, unknown>)[WAYFIND_GRILL_KEY];
  return typeof fn === "function" ? (fn as (id: string) => boolean)(sessionId) : false;
}

beforeEach(() => {
  delete (globalThis as any)[WAYFIND_GRILL_KEY];
});
afterEach(() => {
  delete (globalThis as any)[WAYFIND_GRILL_KEY];
});

test("seam is absent (false) when nothing published", () => {
  expect(readSeam("sess-1")).toBe(false);
});

test("publishWayfindGrill exposes a per-session grill-active reader", () => {
  const state = createRuntimeState();
  publishWayfindGrill(state);
  state.activeGrillBySession.set("sess-1", "auth redesign");
  state.activeGrillBySession.set("sess-2", "(current conversation)");
  expect(readSeam("sess-1")).toBe(true);
  expect(readSeam("sess-2")).toBe(true);
  expect(readSeam("sess-3")).toBe(false); // no grill for this session
});

test("grill seam is false for a wayfinder-only session (no grill)", () => {
  const state = createRuntimeState();
  publishWayfindGrill(state);
  // wayfinder-only (no grill) → grill seam false
  state.activeEffortBySession.set("sess-1", "big-effort");
  expect(readSeam("sess-1")).toBe(false);
});

test("unpublishWayfindGrill clears the global", () => {
  const state = createRuntimeState();
  publishWayfindGrill(state);
  unpublishWayfindGrill();
  expect(readSeam("sess-1")).toBe(false);
});
