import { afterEach, describe, expect, it } from "bun:test";
import { WAYFIND_ACTIVE_KEY } from "../src/constants.js";
import {
  isWayfindActivePublished,
  publishWayfindActive,
  readPlanIncomplete,
  readPlanSummary,
  unpublishWayfindActive,
} from "../src/coordination.js";
import { createRuntimeState } from "../src/state.js";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY];
});

describe("publishWayfindActive / isWayfindActivePublished", () => {
  it("is false before anything is published (graceful)", () => {
    delete (globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY];
    expect(isWayfindActivePublished()).toBe(false);
  });

  it("publishes a live reader over RuntimeState — flips as grill state changes", () => {
    const state = createRuntimeState();
    publishWayfindActive(state);
    expect(isWayfindActivePublished()).toBe(false); // no grill yet

    state.activeGrillBySession.set("s1", "topic");
    expect(isWayfindActivePublished()).toBe(true);

    state.activeGrillBySession.delete("s1");
    expect(isWayfindActivePublished()).toBe(false);
  });

  it("a wayfinder effort also counts as active", () => {
    const state = createRuntimeState();
    publishWayfindActive(state);
    state.activeEffortBySession.set("s1", "orders");
    expect(isWayfindActivePublished()).toBe(true);
  });
});

describe("unpublishWayfindActive", () => {
  it("removes the global so the reader is gone", () => {
    const state = createRuntimeState();
    publishWayfindActive(state);
    expect(isWayfindActivePublished()).toBe(false);
    state.activeGrillBySession.set("s1", "x");
    expect(isWayfindActivePublished()).toBe(true);
    unpublishWayfindActive();
    // After unpublish the global itself is gone → reader returns false.
    expect((globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY]).toBeUndefined();
  });
});

describe("readPlanIncomplete / readPlanSummary (planning-with-files seam)", () => {
  it("graceful fallback when planning-with-files is absent", () => {
    delete (globalThis as Record<string, unknown>).__piPlanIncomplete;
    delete (globalThis as Record<string, unknown>).__piPlanSummary;
    expect(readPlanIncomplete("/any/cwd")).toBe(false);
    expect(readPlanSummary("/any/cwd")).toBe("");
  });

  it("reads the published functions when present", () => {
    (globalThis as Record<string, unknown>).__piPlanIncomplete = () => true;
    (globalThis as Record<string, unknown>).__piPlanSummary = () => "2/4 phases";
    expect(readPlanIncomplete("/any/cwd")).toBe(true);
    expect(readPlanSummary("/any/cwd")).toBe("2/4 phases");
    delete (globalThis as Record<string, unknown>).__piPlanIncomplete;
    delete (globalThis as Record<string, unknown>).__piPlanSummary;
  });
});
