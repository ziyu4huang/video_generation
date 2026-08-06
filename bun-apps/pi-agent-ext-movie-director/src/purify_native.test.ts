import { describe, expect, it } from "bun:test";
import { TRANSFORMER_DENOISE, parsePurifyResolution, purifyResolutionLabel } from "./purify_native.ts";

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
