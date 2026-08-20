// tests/grill-seam.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { readGrillActive } from "../src/grill-seam.js";

beforeEach(() => { delete (globalThis as any).__piWayfindGrill; });
afterEach(() => { delete (globalThis as any).__piWayfindGrill; });

test("readGrillActive: no seam → false", () => {
  expect(readGrillActive("sess-1")).toBe(false);
});

test("readGrillActive: seam reports per-session grill state", () => {
  (globalThis as any).__piWayfindGrill = (id: string) => id === "sess-1";
  expect(readGrillActive("sess-1")).toBe(true);
  expect(readGrillActive("sess-2")).toBe(false);
});

test("readGrillActive: undefined sessionId → false", () => {
  (globalThis as any).__piWayfindGrill = (id: string) => true;
  expect(readGrillActive(undefined)).toBe(false);
});
