import { describe, it, expect } from "bun:test";
import { t2iCommand } from "./t2i";
import { invariants } from "./test-helpers";

invariants(t2iCommand);

describe("t2i: isDisabled", () => {
  const fn = t2iCommand.isDisabled!;

  it("disabled when prompt is empty string", () => {
    expect(fn({ prompt: "" })).toBe(true);
  });

  it("disabled when prompt is only whitespace", () => {
    expect(fn({ prompt: "   " })).toBe(true);
  });

  it("disabled when prompt is undefined", () => {
    expect(fn({})).toBe(true);
  });

  it("enabled when prompt has content", () => {
    expect(fn({ prompt: "a cat" })).toBe(false);
  });

  it("enabled when prompt has content with surrounding whitespace", () => {
    expect(fn({ prompt: "  hello  " })).toBe(false);
  });
});

describe("t2i: buildParams", () => {
  const fn = t2iCommand.buildParams!;

  it("trims prompt", () => {
    const result = fn({ prompt: "  hello  ", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 1.0, count: 1 });
    expect(result.prompt).toBe("hello");
  });

  it("omits lora flags when no LoRAs selected", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, count: 1 });
    expect(result.lora_path).toBeUndefined();
    expect(result.lora_scale).toBeUndefined();
  });

  it("derives lora_path/lora_scale arrays from the loras editor", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, count: 1, loras: [{ path: "/a.safetensors", scale: 0.5 }, { path: "/b.safetensors", scale: 0.8 }] });
    expect(result.lora_path).toEqual(["/a.safetensors", "/b.safetensors"]);
    expect(result.lora_scale).toEqual(["0.50", "0.80"]);
  });

  it("omits draft when falsy", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 1.0, count: 1, draft: false });
    expect(result.draft).toBeUndefined();
  });

  it("includes draft when true", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 1.0, count: 1, draft: true });
    expect(result.draft).toBe(true);
  });

  it("omits count when <= 1", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 1.0, count: 1 });
    expect(result.count).toBeUndefined();
  });

  it("includes count when > 1", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 1.0, count: 4 });
    expect(result.count).toBe(4);
  });

  it("never sends steps — server picks the per-pipeline optimum", () => {
    // Even if state.steps is populated (by the pipeline→steps auto-fill hook),
    // buildParams drops it so the backend resolves _PIPELINE_DEFAULT_STEPS
    // (zimage=9, flux2-klein=4, lens=20). The steps field is also hidden in the UI.
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 1.0, count: 1, steps: 20 });
    expect(result.steps).toBeUndefined();
  });
});

describe("t2i: pipeline choices (lens support)", () => {
  it("exposes lens alongside zimage/flux2-klein/auto", () => {
    const pipelineField = t2iCommand.fields.find((f) => f.key === "pipeline")!;
    expect(pipelineField.choices!.map((c) => c.value)).toEqual(["zimage", "flux2-klein", "lens", "auto"]);
  });

  it("forwards lens as the pipeline param", () => {
    const fn = t2iCommand.buildParams!;
    const result = fn({ prompt: "a corgi", pipeline: "lens", width: 512, height: 512, seed: 42, lora_scale: 1.0, count: 1 });
    expect(result.pipeline).toBe("lens");
  });

  it("hides the steps field from the UI", () => {
    const stepsField = t2iCommand.fields.find((f) => f.key === "steps")!;
    expect(stepsField.visible).toBeDefined();
    expect(stepsField.visible!({})).toBe(false);
  });
});
