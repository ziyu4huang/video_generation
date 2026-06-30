import { describe, it, expect } from "bun:test";
import { i2iCommand } from "./i2i";
import { invariants } from "./test-helpers";

invariants(i2iCommand);

describe("i2i: isDisabled", () => {
  const fn = i2iCommand.isDisabled!;

  it("disabled when input_image is absent", () => {
    expect(fn({})).toBe(true);
  });

  it("disabled when input_image is empty string", () => {
    expect(fn({ input_image: "" })).toBe(true);
  });

  it("enabled when input_image is set", () => {
    expect(fn({ input_image: "/path/to/image.png" })).toBe(false);
  });
});

describe("i2i: buildParams", () => {
  const fn = i2iCommand.buildParams!;

  const base = {
    input_image: "/img.png",
    denoise_strength: 0.4,
    pipeline: "zimage",
    seed: 42,
  };

  it("includes input_image", () => {
    expect(fn(base).input_image).toBe("/img.png");
  });

  it("omits reference_image when not set", () => {
    expect(fn(base).reference_image).toBeUndefined();
  });

  it("includes reference_image when provided", () => {
    const result = fn({ ...base, reference_image: "/ref.png" });
    expect(result.reference_image).toBe("/ref.png");
  });

  it("omits controlnet_strength when no reference_image", () => {
    const result = fn({ ...base, controlnet_strength: 0.8 });
    expect(result.controlnet_strength).toBeUndefined();
  });

  it("includes controlnet_strength when reference_image present", () => {
    const result = fn({ ...base, reference_image: "/ref.png", controlnet_strength: 0.8 });
    expect(result.controlnet_strength).toBe(0.8);
  });

  it("omits prompt when empty", () => {
    const result = fn({ ...base, prompt: "" });
    expect(result.prompt).toBeUndefined();
  });

  it("trims and includes prompt when non-empty", () => {
    const result = fn({ ...base, prompt: "  add hat  " });
    expect(result.prompt).toBe("add hat");
  });

  it("omits steps when undefined", () => {
    expect(fn(base).steps).toBeUndefined();
  });

  it("includes steps when provided", () => {
    expect(fn({ ...base, steps: 30 }).steps).toBe(30);
  });
});
