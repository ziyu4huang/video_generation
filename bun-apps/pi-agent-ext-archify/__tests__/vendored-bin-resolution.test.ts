import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveVendoredBin, runArchify, VENDORED_BIN } from "../lib/run.ts";

const _env = process.env.PI_ARCHIFY_BIN;
afterEach(() => {
  if (_env === undefined) delete process.env.PI_ARCHIFY_BIN;
  else process.env.PI_ARCHIFY_BIN = _env;
});

describe("resolveVendoredBin", () => {
  it("honors PI_ARCHIFY_BIN env override first", () => {
    process.env.PI_ARCHIFY_BIN = "/custom/path/archify.mjs";
    expect(resolveVendoredBin("/anywhere")).toBe("/custom/path/archify.mjs");
  });

  it("finds vendored/bin/archify.mjs at the start dir (depth 0)", () => {
    const root = mkdtempSync(join(tmpdir(), "vbr-start-"));
    mkdirSync(join(root, "vendored", "bin"), { recursive: true });
    writeFileSync(join(root, "vendored", "bin", "archify.mjs"), "// stub");
    try {
      const got = resolveVendoredBin(root);
      expect(got).toBe(join(root, "vendored", "bin", "archify.mjs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks up to find vendored/bin/archify.mjs at an ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "vbr-walk-"));
    mkdirSync(join(root, "a", "b", "c"), { recursive: true });
    mkdirSync(join(root, "a", "vendored", "bin"), { recursive: true });
    writeFileSync(join(root, "a", "vendored", "bin", "archify.mjs"), "// stub");
    try {
      const got = resolveVendoredBin(join(root, "a", "b", "c"));
      expect(got).toBe(join(root, "a", "vendored", "bin", "archify.mjs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy source-relative path when nothing is found", () => {
    const empty = mkdtempSync(join(tmpdir(), "vbr-empty-"));
    try {
      delete process.env.PI_ARCHIFY_BIN;
      const got = resolveVendoredBin(empty);
      // Fallback is PKG_ROOT/vendored/bin/archify.mjs (fixed, independent of startDir).
      expect(got.endsWith("vendored/bin/archify.mjs")).toBe(true);
      expect(got).not.toBe(join(empty, "vendored", "bin", "archify.mjs"));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("runArchify pre-flight", () => {
  it("returns a 'vendored bin not found' error when the bin path does not exist", async () => {
    const result = await runArchify(["--version"], tmpdir(), undefined, "/definitely/nonexistent/archify.mjs");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("vendored bin not found");
    expect(result.stderr).toContain("PI_ARCHIFY_BIN");
  });
});

describe("VENDORED_BIN module constant", () => {
  it("is a string ending in vendored/bin/archify.mjs", () => {
    expect(typeof VENDORED_BIN).toBe("string");
    expect(VENDORED_BIN.endsWith("vendored/bin/archify.mjs")).toBe(true);
  });
});
