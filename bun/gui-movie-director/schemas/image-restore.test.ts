import { describe, it, expect } from "bun:test";
import { imageRestoreCommand } from "./image-restore";
import { invariants } from "./test-helpers";

invariants(imageRestoreCommand);

describe("image-restore: isDisabled", () => {
  it("is disabled when input_image is absent", () => {
    expect(imageRestoreCommand.isDisabled!({})).toBe(true);
  });

  it("is disabled when input_image is empty string", () => {
    expect(imageRestoreCommand.isDisabled!({ input_image: "" })).toBe(true);
  });

  it("is enabled when input_image is set", () => {
    expect(imageRestoreCommand.isDisabled!({ input_image: "/img.png" })).toBe(false);
  });
});

describe("image-restore: buildParams", () => {
  const base = { input_image: "/img.png", denoise_strength: 0.35, pipeline: "zimage", seed: 42 };

  it("includes input_image", () => {
    const r = imageRestoreCommand.buildParams!(base);
    expect(r.input_image).toBe("/img.png");
  });

  it("includes denoise_strength, pipeline, seed", () => {
    const r = imageRestoreCommand.buildParams!(base);
    expect(r.denoise_strength).toBe(0.35);
    expect(r.pipeline).toBe("zimage");
    expect(r.seed).toBe(42);
  });

  it("omits prompt when empty or whitespace", () => {
    const r = imageRestoreCommand.buildParams!({ ...base, prompt: "  " });
    expect(r.prompt).toBeUndefined();
  });

  it("includes trimmed prompt when set", () => {
    const r = imageRestoreCommand.buildParams!({ ...base, prompt: " sharp eyes " });
    expect(r.prompt).toBe("sharp eyes");
  });

  it("omits steps when not set", () => {
    const r = imageRestoreCommand.buildParams!({ ...base, steps: undefined });
    expect(r.steps).toBeUndefined();
  });

  it("includes steps when set", () => {
    const r = imageRestoreCommand.buildParams!({ ...base, steps: 20 });
    expect(r.steps).toBe(20);
  });
});
