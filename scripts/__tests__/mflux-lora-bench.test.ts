/**
 * Tests for mflux-lora-bench.ts — LoRA style evaluation benchmark.
 *
 * Run: bun test scripts/__tests__/mflux-lora-bench.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  parseLoraArgs,
  loraStyles,
  buildCommand,
  buildComparisonGrid,
  recommendationTable,
  type LoraBenchArgs,
  type LoraResult,
} from "../mflux-lora-bench";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), `lora-bench-test-${Date.now()}`);

describe("mflux-lora-bench", () => {
  // ── Arg parsing ───────────────────────────────────────────────────────

  describe("parseLoraArgs", () => {
    test("parses defaults", () => {
      const args = parseLoraArgs([]);
      expect(args.model).toBe("flux2-klein-4b");
      expect(args.seed).toBe(42);
      expect(args.steps).toBe(4);
      expect(args.outputDir).toContain("output/benchmarks/lora");
    });

    test("parses custom model and seed", () => {
      const args = parseLoraArgs(["--model", "flux1-dev", "--seed", "123"]);
      expect(args.model).toBe("flux1-dev");
      expect(args.seed).toBe(123);
    });

    test("parses output dir", () => {
      const args = parseLoraArgs(["--output", "/tmp/lora-test"]);
      expect(args.outputDir).toBe("/tmp/lora-test");
    });

    test("parses --prompt", () => {
      const args = parseLoraArgs(["--prompt", "a warrior in armor"]);
      expect(args.prompt).toBe("a warrior in armor");
    });
  });

  // ── LoRA styles ───────────────────────────────────────────────────────

  describe("loraStyles", () => {
    test("includes required styles", () => {
      const names = loraStyles.map((s) => s.name);
      expect(names).toContain("none");
      expect(names).toContain("illustration");
      expect(names).toContain("storyboard");
      expect(names).toContain("portrait");
    });

    test("each style has name and flag", () => {
      for (const style of loraStyles) {
        expect(style.name).toBeTruthy();
        if (style.name !== "none") {
          expect(style.flag).toBeTruthy();
        }
      }
    });
  });

  // ── Command building ──────────────────────────────────────────────────

  describe("buildCommand", () => {
    test("no-LoRA baseline has no --lora-style flag", () => {
      const args: LoraBenchArgs = { model: "flux2-klein-4b", seed: 42, steps: 4, outputDir: "/tmp", prompt: "test" };
      const cmd = buildCommand(args, loraStyles[0], "/tmp/out.png");
      expect(cmd).toContain("mflux");
      expect(cmd).toContain("--seed 42");
      expect(cmd).not.toContain("--lora-style");
    });

    test("LoRA style includes --lora-style flag", () => {
      const args: LoraBenchArgs = { model: "flux2-klein-4b", seed: 42, steps: 4, outputDir: "/tmp", prompt: "test" };
      const illustration = loraStyles.find((s) => s.name === "illustration")!;
      const cmd = buildCommand(args, illustration, "/tmp/out.png");
      expect(cmd).toContain("--lora-style illustration");
    });
  });

  // ── Comparison grid ───────────────────────────────────────────────────

  describe("buildComparisonGrid", () => {
    test("produces markdown table from results", () => {
      const results: LoraResult[] = [
        { style: "none", path: "/tmp/none.png", timeMs: 1200, sizeKb: 350 },
        { style: "illustration", path: "/tmp/illust.png", timeMs: 1400, sizeKb: 380 },
      ];
      const grid = buildComparisonGrid(results);
      expect(grid).toContain("| Style |");
      expect(grid).toContain("| none |");
      expect(grid).toContain("| illustration |");
    });
  });

  // ── Recommendation table ──────────────────────────────────────────────

  describe("recommendationTable", () => {
    test("includes game asset categories", () => {
      const table = recommendationTable();
      expect(table).toContain("character");
      expect(table).toContain("background");
      expect(table).toContain("item");
    });

    test("is valid markdown table", () => {
      const table = recommendationTable();
      const lines = table.split("\n").filter((l) => l.trim());
      expect(lines[0]).toMatch(/^\|/);
      expect(lines[1]).toMatch(/^\|[-|]+\|$/);
    });
  });
});
