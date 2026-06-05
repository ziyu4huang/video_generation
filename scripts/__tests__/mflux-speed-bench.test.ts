/**
 * Tests for mflux-speed-bench.ts — Z-Image Turbo vs FLUX.2 Klein 4B speed benchmark.
 *
 * Run: bun test scripts/__tests__/mflux-speed-bench.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  parseSpeedArgs,
  speedConfigs,
  buildSpeedCommand,
  buildSpeedTable,
  type SpeedBenchArgs,
  type SpeedResult,
} from "../mflux-speed-bench";

describe("mflux-speed-bench", () => {
  // ── Arg parsing ───────────────────────────────────────────────────────

  describe("parseSpeedArgs", () => {
    test("parses defaults", () => {
      const args = parseSpeedArgs([]);
      expect(args.seed).toBe(42);
      expect(args.size).toBe(512);
      expect(args.outputDir).toContain("output/benchmarks/speed");
    });

    test("parses custom values", () => {
      const args = parseSpeedArgs(["--seed", "99", "--size", "1024", "--output", "/tmp/speed"]);
      expect(args.seed).toBe(99);
      expect(args.size).toBe(1024);
      expect(args.outputDir).toBe("/tmp/speed");
    });
  });

  // ── Config matrix ─────────────────────────────────────────────────────

  describe("speedConfigs", () => {
    test("includes Z-Image Turbo configs", () => {
      const zimage = speedConfigs.filter((c) => c.model === "z-image-turbo");
      expect(zimage.length).toBeGreaterThanOrEqual(3);
      const steps = zimage.map((c) => c.steps);
      expect(steps).toContain(4);
      expect(steps).toContain(6);
      expect(steps).toContain(9);
    });

    test("includes FLUX.2 Klein 4B baseline", () => {
      const klein = speedConfigs.filter((c) => c.model === "flux2-klein-4b");
      expect(klein.length).toBeGreaterThanOrEqual(1);
    });

    test("each config has model, steps, label", () => {
      for (const c of speedConfigs) {
        expect(c.model).toBeTruthy();
        expect(c.steps).toBeGreaterThan(0);
        expect(c.label).toBeTruthy();
      }
    });
  });

  // ── Command building ──────────────────────────────────────────────────

  describe("buildSpeedCommand", () => {
    test("builds mflux command with correct model and steps", () => {
      const args: SpeedBenchArgs = { seed: 42, size: 512, outputDir: "/tmp", prompt: "test" };
      const config = speedConfigs[0];
      const cmd = buildSpeedCommand(args, config, "/tmp/out.png");
      expect(cmd).toContain(`--model ${config.model}`);
      expect(cmd).toContain(`--steps ${config.steps}`);
      expect(cmd).toContain("--seed 42");
    });
  });

  // ── Speed table ───────────────────────────────────────────────────────

  describe("buildSpeedTable", () => {
    test("produces markdown table from results", () => {
      const results: SpeedResult[] = [
        { label: "z-image-4s", model: "z-image-turbo", steps: 4, timeMs: 800, peakMemGb: 8.2 },
        { label: "klein-4s", model: "flux2-klein-4b", steps: 4, timeMs: 1200, peakMemGb: 10.1 },
      ];
      const table = buildSpeedTable(results);
      expect(table).toContain("| Model | Steps | Time/img | Peak Mem |");
      expect(table).toContain("z-image-4s");
      expect(table).toContain("klein-4s");
    });

    test("calculates quality-per-second ratio column", () => {
      const results: SpeedResult[] = [
        { label: "a", model: "m1", steps: 4, timeMs: 1000, peakMemGb: 8, qualityScore: 5 },
        { label: "b", model: "m2", steps: 4, timeMs: 2000, peakMemGb: 8, qualityScore: 5 },
      ];
      const table = buildSpeedTable(results);
      // Quality/s = qualityScore / (timeMs / 1000)
      expect(table).toContain("5.0");  // a: 5 / 1.0
      expect(table).toContain("2.5");  // b: 5 / 2.0
    });
  });
});
