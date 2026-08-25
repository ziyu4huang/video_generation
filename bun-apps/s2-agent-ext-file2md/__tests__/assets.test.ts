/**
 * assets — payload resolution across the two layouts.
 *
 * Deploy: <extDir>/vendored/… (registry assets block; NO node_modules ships).
 * Dev: the workspace npm install. The vendored probe MUST win when the layout
 * is present and the npm fallback MUST keep dev working when it is not —
 * the 2026-08-25 layout change breaks either side silently if this ordering
 * drifts (OCR degrades to "no text", never throws).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfiumWasmPath, pdfjsAssetDirUrl, tessdataPath, tesseractWasmPath } from "../src/assets.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeExtDir(): string {
  const d = mkdtempSync(join(tmpdir(), "f2md-assets-"));
  tmpDirs.push(d);
  return d;
}

describe("vendored layout (deploy)", () => {
  test("tesseract core resolves from <extDir>/vendored/ when present", () => {
    const extDir = fakeExtDir();
    const wasm = join(extDir, "vendored", "tesseract-wasm", "tesseract-core.wasm");
    mkdirSync(join(wasm, ".."), { recursive: true });
    writeFileSync(wasm, "wasm-bytes");
    expect(tesseractWasmPath(extDir)).toBe(wasm);
  });

  test("pdfium core resolves from <extDir>/vendored/pdfium/", () => {
    const extDir = fakeExtDir();
    const wasm = join(extDir, "vendored", "pdfium", "pdfium.wasm");
    mkdirSync(join(wasm, ".."), { recursive: true });
    writeFileSync(wasm, "pdfium-bytes");
    expect(pdfiumWasmPath(extDir)).toBe(wasm);
  });

  test("tessdata resolves per lang part", () => {
    const extDir = fakeExtDir();
    const gz = join(extDir, "vendored", "tessdata", "eng.traineddata.gz");
    mkdirSync(join(gz, ".."), { recursive: true });
    writeFileSync(gz, "gz-bytes");
    expect(tessdataPath("eng", extDir)).toBe(gz);
    // chi_sim has no vendored copy in this fixture → npm fallback (present
    // in the dev install), NOT undefined.
    expect(tessdataPath("chi_sim", extDir)).toContain("4.0.0_best_int");
  });

  test("pdfjs dir URL carries the trailing separator pdfjs concatenates onto", () => {
    const extDir = fakeExtDir();
    mkdirSync(join(extDir, "vendored", "pdfjs", "wasm"), { recursive: true });
    expect(pdfjsAssetDirUrl("wasm", extDir)).toBe(join(extDir, "vendored", "pdfjs", "wasm") + "/");
  });

  test("an ext dir WITHOUT the payload falls back to the npm layout", () => {
    const extDir = fakeExtDir();
    const resolved = tesseractWasmPath(extDir);
    expect(resolved).toBeDefined();
    expect(resolved!.includes("vendored")).toBe(false);
    expect(resolved!.endsWith(join("tesseract-wasm", "dist", "tesseract-core.wasm"))).toBe(true);
  });
});

describe("npm layout (dev)", () => {
  test("all four payload kinds resolve from the workspace install", () => {
    expect(existsSync(tesseractWasmPath())).toBe(true);
    expect(existsSync(pdfiumWasmPath())).toBe(true);
    expect(existsSync(tessdataPath("eng"))).toBe(true);
    expect(existsSync(tessdataPath("chi_sim"))).toBe(true);
    expect(existsSync(pdfjsAssetDirUrl("wasm"))).toBe(true);
    expect(existsSync(pdfjsAssetDirUrl("standard_fonts"))).toBe(true);
    expect(existsSync(pdfjsAssetDirUrl("cmaps"))).toBe(true);
    expect(existsSync(pdfjsAssetDirUrl("iccs"))).toBe(true);
  });

  test("an unknown lang part degrades to undefined (never throws)", () => {
    expect(tessdataPath("klingon")).toBeUndefined();
  });
});
