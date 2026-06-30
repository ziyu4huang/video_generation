import { describe, it, expect } from "bun:test";
import { expansionCommand } from "./expansion";
import { invariants } from "./test-helpers";

invariants(expansionCommand);

describe("expansion: isDisabled", () => {
  it("is disabled when input_image is absent", () => {
    expect(expansionCommand.isDisabled!({})).toBe(true);
  });

  it("is enabled when input_image is set", () => {
    expect(expansionCommand.isDisabled!({ input_image: "/img.png" })).toBe(false);
  });
});

describe("expansion: buildParams — direction mode", () => {
  const base = {
    input_image: "/img.png", mode: "direction",
    expand_left: false, expand_right: true, expand_up: false, expand_down: true,
    pixels: 1024, feather: 96, overlap: 128, longest: 1024, expansion_ref_strength: 1.0, seed: 42,
  };

  it("includes input_image", () => {
    const r = expansionCommand.buildParams!(base);
    expect(r.input_image).toBe("/img.png");
  });

  it("combines direction toggles into comma-separated expand string", () => {
    const r = expansionCommand.buildParams!(base);
    expect(r.expand).toBe("right,down");
  });

  it("expand includes left when expand_left is true", () => {
    const r = expansionCommand.buildParams!({ ...base, expand_left: true });
    expect(r.expand).toContain("left");
  });

  it("expand includes up when expand_up is true", () => {
    const r = expansionCommand.buildParams!({ ...base, expand_up: true });
    expect(r.expand).toContain("up");
  });

  it("omits aspect in direction mode", () => {
    const r = expansionCommand.buildParams!(base);
    expect(r.aspect).toBeUndefined();
  });

  it("includes pixels in direction mode", () => {
    const r = expansionCommand.buildParams!(base);
    expect(r.pixels).toBe(1024);
  });

  it("omits expansion_feather when 96 (default)", () => {
    const r = expansionCommand.buildParams!({ ...base, feather: 96 });
    expect(r.expansion_feather).toBeUndefined();
  });

  it("includes expansion_feather when not default", () => {
    const r = expansionCommand.buildParams!({ ...base, feather: 64 });
    expect(r.expansion_feather).toBe(64);
  });

  it("omits overlap when 128 (default)", () => {
    const r = expansionCommand.buildParams!({ ...base, overlap: 128 });
    expect(r.overlap).toBeUndefined();
  });

  it("includes overlap when not default", () => {
    const r = expansionCommand.buildParams!({ ...base, overlap: 200 });
    expect(r.overlap).toBe(200);
  });

  it("omits expansion_ref_strength when 1.0 (default)", () => {
    const r = expansionCommand.buildParams!({ ...base, expansion_ref_strength: 1.0 });
    expect(r.expansion_ref_strength).toBeUndefined();
  });

  it("includes expansion_ref_strength when not default", () => {
    const r = expansionCommand.buildParams!({ ...base, expansion_ref_strength: 0.8 });
    expect(r.expansion_ref_strength).toBe(0.8);
  });

  it("omits prompt when empty", () => {
    const r = expansionCommand.buildParams!({ ...base, prompt: "" });
    expect(r.prompt).toBeUndefined();
  });

  it("includes trimmed prompt when set", () => {
    const r = expansionCommand.buildParams!({ ...base, prompt: "  blue sky  " });
    expect(r.prompt).toBe("blue sky");
  });
});

describe("expansion: buildParams — aspect mode", () => {
  const base = {
    input_image: "/img.png", mode: "aspect", aspect: "16:9",
    expand_left: false, expand_right: true, expand_up: false, expand_down: false,
    pixels: 1024, feather: 96, overlap: 128, longest: 1024, expansion_ref_strength: 1.0, seed: 42,
  };

  it("omits expand in aspect mode", () => {
    const r = expansionCommand.buildParams!(base);
    expect(r.expand).toBeUndefined();
  });

  it("omits pixels in aspect mode", () => {
    const r = expansionCommand.buildParams!(base);
    expect(r.pixels).toBeUndefined();
  });

  it("includes aspect ratio string", () => {
    const r = expansionCommand.buildParams!(base);
    expect(r.aspect).toBe("16:9");
  });
});

describe("expansion: field visible callbacks", () => {
  const getField = (key: string) => expansionCommand.fields.find((f) => f.key === key)!;

  it("expand_left visible returns true in direction mode", () => {
    expect(getField("expand_left").visible!({ mode: "direction" })).toBe(true);
  });

  it("expand_left visible returns false in aspect mode", () => {
    expect(getField("expand_left").visible!({ mode: "aspect" })).toBe(false);
  });

  it("expand_right visible returns true in direction mode", () => {
    expect(getField("expand_right").visible!({ mode: "direction" })).toBe(true);
  });

  it("expand_right visible returns false in aspect mode", () => {
    expect(getField("expand_right").visible!({ mode: "aspect" })).toBe(false);
  });

  it("expand_up visible returns true in direction mode", () => {
    expect(getField("expand_up").visible!({ mode: "direction" })).toBe(true);
  });

  it("expand_down visible returns true in direction mode", () => {
    expect(getField("expand_down").visible!({ mode: "direction" })).toBe(true);
  });

  it("pixels visible returns true in direction mode", () => {
    expect(getField("pixels").visible!({ mode: "direction" })).toBe(true);
  });

  it("pixels visible returns false in aspect mode", () => {
    expect(getField("pixels").visible!({ mode: "aspect" })).toBe(false);
  });

  it("aspect field visible returns true in aspect mode", () => {
    expect(getField("aspect").visible!({ mode: "aspect" })).toBe(true);
  });

  it("aspect field visible returns false in direction mode", () => {
    expect(getField("aspect").visible!({ mode: "direction" })).toBe(false);
  });
});

describe("expansion: buildParams — edge cases", () => {
  const base = {
    input_image: "/img.png", mode: "direction",
    expand_left: false, expand_right: false, expand_up: false, expand_down: false,
    pixels: 1024, feather: 96, overlap: 128, longest: 1024, expansion_ref_strength: 1.0, seed: 42,
  };

  it("expand is empty string when all direction toggles are false", () => {
    const r = expansionCommand.buildParams!(base);
    expect(r.expand).toBe("");
  });

  it("omits prompt when prompt is undefined", () => {
    const r = expansionCommand.buildParams!({ ...base, prompt: undefined });
    expect(r.prompt).toBeUndefined();
  });

  it("omits prompt when prompt is whitespace only", () => {
    const r = expansionCommand.buildParams!({ ...base, prompt: "   " });
    expect(r.prompt).toBeUndefined();
  });

  it("includes seed as-is", () => {
    const r = expansionCommand.buildParams!({ ...base, seed: 99 });
    expect(r.seed).toBe(99);
  });

  it("includes longest as-is", () => {
    const r = expansionCommand.buildParams!({ ...base, longest: 2048 });
    expect(r.longest).toBe(2048);
  });
});
