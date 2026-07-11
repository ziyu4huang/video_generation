/**
 * set-package-dir + skip-update-check — unit tests for the pure decision logic.
 *
 * The import-time side effects (setting process.env) are intentionally NOT
 * tested here; they are thin wrappers around the pure functions. Mirrors the
 * resolvePatchPlan / resolveEnvBridges split used by the other patch tests.
 */
import { describe, expect, test } from "bun:test";
import { shouldSetPackageDir } from "./set-package-dir.ts";
import { shouldSkipUpdateCheck } from "./skip-update-check.ts";
import type { BundlerMode } from "../mode.ts";

const MODES: BundlerMode[] = ["source", "bundle", "binary"];

describe("shouldSetPackageDir — mode + path gating", () => {
  test("source mode → never set (pi resolves correctly on its own)", () => {
    for (const path of ["", "/some/path", "/abs/to/pi"]) {
      expect(shouldSetPackageDir("source", path)).toBe(false);
    }
  });

  test("bundle mode + empty path → false (keeps source/fresh-checkout safe)", () => {
    expect(shouldSetPackageDir("bundle", "")).toBe(false);
  });

  test("bundle mode + valid path → true (the only case that sets PI_PACKAGE_DIR)", () => {
    expect(shouldSetPackageDir("bundle", "/abs/to/pi-pkg")).toBe(true);
  });

  test("binary mode → never set (assets are alongside the exe)", () => {
    for (const path of ["", "/some/path"]) {
      expect(shouldSetPackageDir("binary", path)).toBe(false);
    }
  });

  test("all modes covered", () => {
    // Ensures we didn't miss a mode in the test suite.
    expect(MODES).toEqual(["source", "bundle", "binary"]);
  });
});

describe("shouldSkipUpdateCheck — shipped-artifact gating", () => {
  test("source mode → false (dev still sees upstream pi updates)", () => {
    expect(shouldSkipUpdateCheck("source")).toBe(false);
  });

  test("bundle mode → true (shipped artifact; pi update is meaningless)", () => {
    expect(shouldSkipUpdateCheck("bundle")).toBe(true);
  });

  test("binary mode → true (compiled binary; pi update is meaningless)", () => {
    expect(shouldSkipUpdateCheck("binary")).toBe(true);
  });
});
