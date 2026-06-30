import { describe, it, expect } from "bun:test";
import { faceswapCommand } from "./faceswap";
import { invariants } from "./test-helpers";

invariants(faceswapCommand);

describe("faceswap: isDisabled", () => {
  it("is disabled when both images are absent", () => {
    expect(faceswapCommand.isDisabled!({})).toBe(true);
  });

  it("is disabled when input_image is missing", () => {
    expect(faceswapCommand.isDisabled!({ face: "/face.png" })).toBe(true);
  });

  it("is disabled when face is missing", () => {
    expect(faceswapCommand.isDisabled!({ input_image: "/body.png" })).toBe(true);
  });

  it("is enabled when both images are set", () => {
    expect(faceswapCommand.isDisabled!({ input_image: "/body.png", face: "/face.png" })).toBe(false);
  });
});

describe("faceswap: buildParams", () => {
  const base = { input_image: "/body.png", face: "/face.png", mode: "head", seed: 42 };

  it("includes input_image and face", () => {
    const r = faceswapCommand.buildParams!(base);
    expect(r.input_image).toBe("/body.png");
    expect(r.face).toBe("/face.png");
  });

  it("includes mode and seed", () => {
    const r = faceswapCommand.buildParams!(base);
    expect(r.mode).toBe("head");
    expect(r.seed).toBe(42);
  });

  it("passes face mode variant", () => {
    const r = faceswapCommand.buildParams!({ ...base, mode: "face" });
    expect(r.mode).toBe("face");
  });
});
