/**
 * Tests for mflux-add-model.ts — model onboarding script.
 *
 * Tests arg parsing, VAE validation, and error handling.
 * Shell commands are mocked — runtime ACs deferred to HITL.
 *
 * Run: bun test scripts/__tests__/mflux-add-model.test.ts
 */

import { describe, test, expect, mock } from "bun:test";
import {
  parseArgs,
  modelUrl,
  cachePath,
  validateVaeDir,
  type AddModelArgs,
} from "../mflux-add-model";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), `mflux-add-model-test-${Date.now()}`);

describe("mflux-add-model", () => {
  // ── Arg parsing ─────────────────────────────────────────────────────────

  describe("parseArgs", () => {
    test("parses required args: ORG/MODEL LOCAL_NAME", () => {
      const args = parseArgs(["anthropics/flux-test", "flux-test"]);
      expect(args.modelRef).toBe("anthropics/flux-test");
      expect(args.localName).toBe("flux-test");
      expect(args.quantize).toBe(4);
    });

    test("parses --quantize flag", () => {
      const args = parseArgs(["anthropics/flux-test", "flux-test", "--quantize", "8"]);
      expect(args.quantize).toBe(8);
    });

    test("parses --cache-dir flag", () => {
      const args = parseArgs(["o/m", "m", "--cache-dir", "/custom/cache"]);
      expect(args.cacheDir).toBe("/custom/cache");
    });

    test("throws on missing model ref", () => {
      expect(() => parseArgs([])).toThrow(/usage/i);
    });

    test("throws on missing local name", () => {
      expect(() => parseArgs(["org/model"])).toThrow(/usage/i);
    });

    test("throws on invalid model ref format", () => {
      expect(() => parseArgs(["nomodel", "test"])).toThrow(/ORG\/MODEL/);
    });

    test("throws on invalid quantize value", () => {
      expect(() => parseArgs(["o/m", "m", "--quantize", "99"])).toThrow(/quantize/);
    });
  });

  // ── URL construction ────────────────────────────────────────────────────

  describe("modelUrl", () => {
    test("constructs HF URL for model file", () => {
      const url = modelUrl("anthropics/flux-test", "model.safetensors");
      expect(url).toBe(
        "https://huggingface.co/anthropics/flux-test/resolve/main/model.safetensors",
      );
    });
  });

  // ── Cache path ──────────────────────────────────────────────────────────

  describe("cachePath", () => {
    test("returns default cache path with quantize suffix", () => {
      const args: AddModelArgs = {
        modelRef: "anthropics/flux-test",
        localName: "flux-test",
        quantize: 4,
        cacheDir: undefined,
      };
      const path = cachePath(args);
      expect(path).toContain("mflux-models");
      expect(path).toContain("flux-test-4bit");
    });

    test("uses custom cache dir when provided", () => {
      const args: AddModelArgs = {
        modelRef: "anthropics/flux-test",
        localName: "flux-test",
        quantize: 4,
        cacheDir: "/custom/cache",
      };
      const path = cachePath(args);
      expect(path).toBe("/custom/cache/flux-test-4bit");
    });
  });

  // ── VAE validation ──────────────────────────────────────────────────────

  describe("validateVaeDir", () => {
    test("returns true when VAE directory exists with files", () => {
      mkdirSync(join(TMP, "vae"), { recursive: true });
      writeFileSync(join(TMP, "vae", "config.json"), "{}");
      expect(validateVaeDir(TMP)).toBe(true);
      rmSync(TMP, { recursive: true });
    });

    test("returns false when VAE directory missing", () => {
      mkdirSync(TMP, { recursive: true });
      expect(validateVaeDir(TMP)).toBe(false);
      rmSync(TMP, { recursive: true });
    });

    test("returns false when VAE directory is empty", () => {
      mkdirSync(join(TMP, "vae"), { recursive: true });
      expect(validateVaeDir(TMP)).toBe(false);
      rmSync(TMP, { recursive: true });
    });
  });
});
