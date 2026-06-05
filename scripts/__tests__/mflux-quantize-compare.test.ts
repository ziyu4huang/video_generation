/**
 * Tests for mflux-quantize-compare.ts — 3-bit vs 4-bit quantization comparison.
 *
 * Run: bun test scripts/__tests__/mflux-quantize-compare.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  parseQuantizeArgs,
  buildQuantizeSaveCmd,
  buildQuantizeGenCmd,
  buildComparisonTable,
  type QuantizeArgs,
  type QuantizeResult,
} from "../mflux-quantize-compare";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("mflux-quantize-compare", () => {
  describe("parseQuantizeArgs", () => {
    test("parses defaults", () => {
      const args = parseQuantizeArgs([]);
      expect(args.model).toBe("flux2-klein-4b");
      expect(args.seed).toBe(42);
      expect(args.steps).toBe(4);
      expect(args.size).toBe(512);
    });

    test("parses custom values", () => {
      const args = parseQuantizeArgs(["--model", "flux1-dev", "--seed", "99", "--steps", "8"]);
      expect(args.model).toBe("flux1-dev");
      expect(args.seed).toBe(99);
      expect(args.steps).toBe(8);
    });

    test("parses output dir", () => {
      const args = parseQuantizeArgs(["--output", "/tmp/qtest"]);
      expect(args.outputDir).toBe("/tmp/qtest");
    });
  });

  describe("buildQuantizeSaveCmd", () => {
    test("builds mflux-save command for 3-bit", () => {
      const args: QuantizeArgs = {
        model: "flux2-klein-4b", seed: 42, steps: 4, size: 512,
        outputDir: "/tmp", prompt: "test", cacheDir: "~/.cache/mflux-models",
      };
      const cmd = buildQuantizeSaveCmd(args, 3);
      expect(cmd).toContain("mflux.save");
      expect(cmd).toContain("--quantize 3");
      expect(cmd).toContain("flux2-klein-4b-3bit");
    });

    test("builds mflux-save command for 4-bit", () => {
      const args: QuantizeArgs = {
        model: "flux2-klein-4b", seed: 42, steps: 4, size: 512,
        outputDir: "/tmp", prompt: "test", cacheDir: "~/.cache/mflux-models",
      };
      const cmd = buildQuantizeSaveCmd(args, 4);
      expect(cmd).toContain("--quantize 4");
      expect(cmd).toContain("flux2-klein-4b-4bit");
    });
  });

  describe("buildQuantizeGenCmd", () => {
    test("uses quantized model path", () => {
      const args: QuantizeArgs = {
        model: "flux2-klein-4b", seed: 42, steps: 4, size: 512,
        outputDir: "/tmp", prompt: "test prompt", cacheDir: "~/.cache/mflux-models",
      };
      const cmd = buildQuantizeGenCmd(args, 3, "/tmp/out.png");
      expect(cmd).toContain("--model");
      expect(cmd).toContain("flux2-klein-4b-3bit");
      expect(cmd).toContain("--seed 42");
      expect(cmd).toContain("--steps 4");
    });
  });

  describe("buildComparisonTable", () => {
    test("produces markdown table with delta row", () => {
      const results: QuantizeResult[] = [
        { bits: 3, timeMs: 1100, peakMemGb: 7.2, sizeKb: 340, qualityScore: 4 },
        { bits: 4, timeMs: 1200, peakMemGb: 10.1, sizeKb: 380, qualityScore: 5 },
      ];
      const table = buildComparisonTable(results);
      expect(table).toContain("| Bits | Time | Peak Mem | Size | Quality |");
      expect(table).toContain("| 3 |");
      expect(table).toContain("| 4 |");
      expect(table).toContain("Δ");
      expect(table).toContain("-28.7%"); // mem reduction: (7.2-10.1)/10.1 ≈ -28.7%
    });

    test("handles single result", () => {
      const results: QuantizeResult[] = [
        { bits: 3, timeMs: 1000, peakMemGb: 8, sizeKb: 350 },
      ];
      const table = buildComparisonTable(results);
      expect(table).toContain("| 3 |");
      expect(table).not.toContain("Δ");
    });
  });
});
