import { describe, expect, test } from "bun:test";
import path from "path";

import { outputPathForLine, stageForLine, upscaleOutputPath } from "../lib/jobs";

describe("stageForLine", () => {
  test("model-load banner → loading", () => {
    expect(stageForLine("  loading models...", "queued")).toBe("loading");
  });

  test("generate banner → generating", () => {
    expect(stageForLine("  generating...", "loading")).toBe("generating");
  });

  test("upscale banner → generating", () => {
    expect(stageForLine("flux2 upscale — RealPLKSR 4× (native MLX)", "queued")).toBe("generating");
  });

  test("✅ result banner → done", () => {
    expect(stageForLine("✅ generated output_20260903_101112.png  (12.3s)", "generating")).toBe("done");
  });

  test("LoRA + noise lines don't move the stage", () => {
    expect(stageForLine("  lora     : details-9b  (scale=0.8, adapters=42)", "loading")).toBeNull();
    expect(stageForLine("   run.json: /out/x.run.json", "done")).toBeNull();
  });
});

describe("outputPathForLine", () => {
  test("indented absolute png echo → path", () => {
    expect(outputPathForLine("   /repo/../video_generation__output/a.png")).toBe(
      "/repo/../video_generation__output/a.png",
    );
  });

  test("non-path lines → null", () => {
    expect(outputPathForLine("✅ generated a.png  (1.0s)")).toBeNull();
    expect(outputPathForLine("   run.json: /out/a.run.json")).toBeNull();
  });
});

describe("upscaleOutputPath", () => {
  test("sits next to the input with .4x", () => {
    expect(upscaleOutputPath("/out/output_1.png")).toBe(path.join("/out", "output_1.4x.png"));
  });
});
