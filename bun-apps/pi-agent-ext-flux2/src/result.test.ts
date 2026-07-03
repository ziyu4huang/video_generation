import { describe, expect, test } from "bun:test";
import { buildScenePipelineDetails } from "./result.ts";
import type { ScenePipelineResult } from "./scenePipeline.ts";

function fakePipeline(overrides: Partial<ScenePipelineResult> = {}): ScenePipelineResult {
  return {
    candidates: [],
    winnerSeed: 1,
    winnerOutput: "/out/winner.png",
    winnerGate: "PASS",
    winnerReason: "best-gate",
    ...overrides,
  };
}

describe("buildScenePipelineDetails", () => {
  test("no hand-repair: output/gate are the winner's own", () => {
    const details = buildScenePipelineDetails("scene", fakePipeline());
    expect(details.output).toBe("/out/winner.png");
    expect(details.gate).toBe("PASS");
    expect(details.ok).toBe(true);
  });

  test("hand-repair succeeded with a real gate: output/gate both describe the REPAIRED image", () => {
    const details = buildScenePipelineDetails(
      "scene",
      fakePipeline({ handRepair: { output: "/out/repaired.png", gate: "FAIL" } }),
    );
    expect(details.output).toBe("/out/repaired.png");
    expect(details.gate).toBe("FAIL");
  });

  test("hand-repair succeeded but its own gate check returned null: gate is honestly null, not the stale pre-repair gate", () => {
    const details = buildScenePipelineDetails(
      "scene",
      fakePipeline({ winnerGate: "WARN", handRepair: { output: "/out/repaired.png", gate: null } }),
    );
    expect(details.output).toBe("/out/repaired.png");
    expect(details.gate).toBeNull();
  });

  test("regression: hand-repair threw entirely (no output) — output AND gate both fall back to the pre-repair winner", () => {
    // The bug: checking `pipeline.handRepair` truthiness (rather than its
    // `.output`) left `gate` forced to null even though `output` correctly
    // fell back to the winner image, whose gate IS known.
    const details = buildScenePipelineDetails(
      "scene",
      fakePipeline({ winnerOutput: "/out/winner.png", winnerGate: "WARN", handRepair: { output: null, gate: null } }),
    );
    expect(details.output).toBe("/out/winner.png");
    expect(details.gate).toBe("WARN");
  });

  test("every candidate failed: ok=false, exitCode=1, output/outputs empty", () => {
    const details = buildScenePipelineDetails(
      "scene",
      fakePipeline({ winnerSeed: null, winnerOutput: null, winnerGate: null, winnerReason: "none" }),
    );
    expect(details.ok).toBe(false);
    expect(details.exitCode).toBe(1);
    expect(details.output).toBeNull();
    expect(details.outputs).toEqual([]);
  });

  test("outputs[] carries the winner's seed alongside the resolved output path", () => {
    const details = buildScenePipelineDetails("scene", fakePipeline({ winnerSeed: 7, winnerOutput: "/out/7.png" }));
    expect(details.outputs).toEqual([{ path: "/out/7.png", seed: 7, width: null, height: null, sizeBytes: null }]);
  });
});
