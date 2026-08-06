import { describe, expect, it } from "bun:test";
import {
  TRANSFORMER_DENOISE,
  parsePurifyResolution,
  purifyResolutionLabel,
  computePurifyDimensions,
} from "./purify_native.ts";

describe("TRANSFORMER_DENOISE — mirrors image-purify.py's TRANSFORMER_DENOISE exactly", () => {
  it("has the exact 4 modes with the exact Python values", () => {
    expect(TRANSFORMER_DENOISE).toEqual({
      purify: 0.35,
      enhance: 0.55,
      deartifact: 0.7,
      redraw: 0.85,
    });
  });
});

describe("parsePurifyResolution — mirrors _parse_resolution's value half", () => {
  it('"same" (and the undefined default) parses to scale 1.0', () => {
    expect(parsePurifyResolution("same")).toBe(1.0);
    expect(parsePurifyResolution("SAME")).toBe(1.0);
    expect(parsePurifyResolution(undefined)).toBe(1.0);
  });

  it('"Nx" parses to a bare scale number', () => {
    expect(parsePurifyResolution("2x")).toBe(2);
    expect(parsePurifyResolution("2.5x")).toBe(2.5);
    expect(parsePurifyResolution("0.5x")).toBe(0.5);
  });

  it("a bare pixel string or number parses to a {pixels} target", () => {
    expect(parsePurifyResolution("2160")).toEqual({ pixels: 2160 });
    expect(parsePurifyResolution(2160)).toEqual({ pixels: 2160 });
  });

  it("throws on garbage input", () => {
    expect(() => parsePurifyResolution("not-a-resolution")).toThrow(/invalid resolution/);
  });
});

describe("purifyResolutionLabel — mirrors _parse_resolution's label half (filename component)", () => {
  it('"same" and undefined label as "same"', () => {
    expect(purifyResolutionLabel("same")).toBe("same");
    expect(purifyResolutionLabel(undefined)).toBe("same");
  });

  it('"Nx" labels with Python\'s str(float) formatting (whole numbers keep ".0")', () => {
    expect(purifyResolutionLabel("2x")).toBe("2.0x");
    expect(purifyResolutionLabel("2.5x")).toBe("2.5x");
  });

  it("a bare pixel value labels as its plain integer string", () => {
    expect(purifyResolutionLabel("2160")).toBe("2160");
    expect(purifyResolutionLabel(2160)).toBe("2160");
  });
});

describe("computePurifyDimensions — mirrors _run_transformer_backend's dimension math", () => {
  it("scale 1.0 (same) uses the input dims, rounded down to 16 (even 'same' rounds)", () => {
    // 1000x1500 -> floor(1000/16)*16=992, floor(1500/16)*16=1488
    expect(computePurifyDimensions(1000, 1500, 1.0)).toEqual({ width: 992, height: 1488 });
  });

  it("a non-1.0 scale multiplies both dims then rounds down to 16", () => {
    // 1000x1500 * 2 = 2000x3000 -> width 2000 is 16-divisible exactly;
    // height 3000 is NOT (3000/16=187.5) -> floor(3000/16)*16=2992
    expect(computePurifyDimensions(1000, 1500, 2)).toEqual({ width: 2000, height: 2992 });
    // 1000x1500 * 0.5 = 500x750 -> floor(500/16)*16=496, floor(750/16)*16=736
    expect(computePurifyDimensions(1000, 1500, 0.5)).toEqual({ width: 496, height: 736 });
  });

  it("a pixel target scales by shortest-side, then rounds down to 16", () => {
    // 1000x1500, target 2000 shortest-side: scale=2000/1000=2 -> 2000x3000
    // (height 3000 rounds down to 2992, same as the direct-scale case above)
    expect(computePurifyDimensions(1000, 1500, { pixels: 2000 })).toEqual({ width: 2000, height: 2992 });
  });

  it("never returns below 16 for a tiny input", () => {
    expect(computePurifyDimensions(4, 4, 1.0)).toEqual({ width: 16, height: 16 });
  });
});
