import { invariants } from "./test-helpers";
import { anime2realCommand } from "./anime2real";

invariants(anime2realCommand);

describe("anime2real: isDisabled", () => {
  it("returns true when input_image is absent", () => {
    expect(anime2realCommand.isDisabled!({ input_image: "" })).toBe(true);
  });

  it("returns true when input_image is undefined", () => {
    expect(anime2realCommand.isDisabled!({ input_image: undefined })).toBe(true);
  });

  it("returns false when input_image has a value", () => {
    expect(anime2realCommand.isDisabled!({ input_image: "path/to/image.png" })).toBe(false);
  });
});

describe("anime2real: buildParams", () => {
  it("omits anime2real_lora_scale when it equals the default (1.0)", () => {
    const result = anime2realCommand.buildParams!({
      input_image: "img.png",
      realism_style: "photorealistic",
      anime2real_lora_scale: 1.0,
      ref_strength: 0.5,
      anime2real_ref_count: 2,
      steps: 8,
      seed: 42,
    });
    expect(result.anime2real_lora_scale).toBeUndefined();
  });

  it("includes anime2real_lora_scale when it differs from the default", () => {
    const result = anime2realCommand.buildParams!({
      input_image: "img.png",
      realism_style: "civitai-chinese",
      anime2real_lora_scale: 0.7,
      ref_strength: 1.0,
      anime2real_ref_count: 1,
      steps: 8,
      seed: 42,
    });
    expect(result.anime2real_lora_scale).toBe(0.7);
  });

  it("omits ref_strength when it equals the default (1.0)", () => {
    const result = anime2realCommand.buildParams!({
      input_image: "img.png",
      realism_style: "3d-game",
      anime2real_lora_scale: 0.5,
      ref_strength: 1.0,
      anime2real_ref_count: 1,
      steps: 8,
      seed: 42,
    });
    expect(result.ref_strength).toBeUndefined();
  });

  it("includes ref_strength when it differs from the default", () => {
    const result = anime2realCommand.buildParams!({
      input_image: "img.png",
      realism_style: "semi-realistic",
      anime2real_lora_scale: 1.0,
      ref_strength: 0.8,
      anime2real_ref_count: 1,
      steps: 8,
      seed: 42,
    });
    expect(result.ref_strength).toBe(0.8);
  });

  it("omits anime2real_ref_count when it equals the default (1)", () => {
    const result = anime2realCommand.buildParams!({
      input_image: "img.png",
      realism_style: "photorealistic",
      anime2real_lora_scale: 1.0,
      ref_strength: 1.0,
      anime2real_ref_count: 1,
      steps: 8,
      seed: 42,
    });
    expect(result.anime2real_ref_count).toBeUndefined();
  });

  it("includes anime2real_ref_count when it differs from the default and passes through steps and seed", () => {
    const result = anime2realCommand.buildParams!({
      input_image: "scene.jpg",
      realism_style: "civitai-chinese",
      anime2real_lora_scale: 1.0,
      ref_strength: 1.0,
      anime2real_ref_count: 3,
      steps: 20,
      seed: 99,
    });
    expect(result.anime2real_ref_count).toBe(3);
    expect(result.steps).toBe(20);
    expect(result.seed).toBe(99);
    expect(result.input_image).toBe("scene.jpg");
    expect(result.realism_style).toBe("civitai-chinese");
  });
});
