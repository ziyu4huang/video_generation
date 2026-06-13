import { invariants } from "./test-helpers";
import { controlnetCommand } from "./controlnet";

invariants(controlnetCommand);

describe("controlnet: isDisabled", () => {
  it("returns true when prompt is absent", () => {
    expect(controlnetCommand.isDisabled!({ prompt: undefined })).toBe(true);
  });

  it("returns true when prompt is an empty string", () => {
    expect(controlnetCommand.isDisabled!({ prompt: "" })).toBe(true);
  });

  it("returns true when prompt is whitespace only", () => {
    expect(controlnetCommand.isDisabled!({ prompt: "   " })).toBe(true);
  });

  it("returns false when prompt has content", () => {
    expect(controlnetCommand.isDisabled!({ prompt: "a futuristic city" })).toBe(false);
  });

  it("returns false when prompt has leading/trailing spaces but has content", () => {
    expect(controlnetCommand.isDisabled!({ prompt: "  portrait  " })).toBe(false);
  });
});

describe("controlnet: buildParams", () => {
  it("omits controlnet_strength when it equals the default (1.0)", () => {
    const result = controlnetCommand.buildParams!({
      prompt: "a forest",
      controlnet_type: "canny",
      controlnet_strength: 1.0,
      seed: 42,
    });
    expect(result.controlnet_strength).toBeUndefined();
  });

  it("includes controlnet_strength when it differs from the default", () => {
    const result = controlnetCommand.buildParams!({
      prompt: "a forest",
      controlnet_type: "canny",
      controlnet_strength: 0.75,
      seed: 42,
    });
    expect(result.controlnet_strength).toBe(0.75);
  });

  it("omits input_image when falsy", () => {
    const result = controlnetCommand.buildParams!({
      prompt: "a forest",
      input_image: "",
      controlnet_type: "depth",
      controlnet_strength: 1.0,
      seed: 42,
    });
    expect(result.input_image).toBeUndefined();
  });

  it("includes input_image when provided", () => {
    const result = controlnetCommand.buildParams!({
      prompt: "a forest",
      input_image: "ref.png",
      controlnet_type: "depth",
      controlnet_strength: 1.0,
      seed: 42,
    });
    expect(result.input_image).toBe("ref.png");
  });

  it("omits blur_ref and remove_outlines when falsy", () => {
    const result = controlnetCommand.buildParams!({
      prompt: "test",
      controlnet_type: "pose",
      controlnet_strength: 1.0,
      blur_ref: false,
      remove_outlines: false,
      seed: 1,
    });
    expect(result.blur_ref).toBeUndefined();
    expect(result.remove_outlines).toBeUndefined();
  });

  it("includes blur_ref and remove_outlines when truthy", () => {
    const result = controlnetCommand.buildParams!({
      prompt: "test",
      controlnet_type: "canny",
      controlnet_strength: 1.0,
      blur_ref: true,
      remove_outlines: true,
      seed: 1,
    });
    expect(result.blur_ref).toBe(true);
    expect(result.remove_outlines).toBe(true);
  });

  it("includes steps when provided and passes through prompt and seed", () => {
    const result = controlnetCommand.buildParams!({
      prompt: "  portrait  ",
      controlnet_type: "hed",
      controlnet_strength: 0.5,
      steps: 20,
      seed: 99,
    });
    expect(result.prompt).toBe("portrait");
    expect(result.steps).toBe(20);
    expect(result.seed).toBe(99);
    expect(result.controlnet_strength).toBe(0.5);
  });

  it("omits steps when not provided (undefined via ?? undefined)", () => {
    const result = controlnetCommand.buildParams!({
      prompt: "test",
      controlnet_type: "canny",
      controlnet_strength: 1.0,
      steps: undefined,
      seed: 42,
    });
    expect(result.steps).toBeUndefined();
  });
});
