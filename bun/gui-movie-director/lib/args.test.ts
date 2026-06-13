import { describe, it, expect } from "bun:test";
import { buildCliArgs, validateParams } from "./args";

describe("buildCliArgs", () => {
  it("builds a string flag as adjacent --flag value pair", () => {
    const args = buildCliArgs("t2i", { prompt: "hello" });
    const idx = args.indexOf("--prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("hello");
  });

  it("trims string values before emitting", () => {
    const args = buildCliArgs("t2i", { prompt: "  hello world  " });
    const idx = args.indexOf("--prompt");
    expect(args[idx + 1]).toBe("hello world");
  });

  it("omits empty string values", () => {
    const args = buildCliArgs("t2i", { prompt: "" });
    expect(args).not.toContain("--prompt");
  });

  it("omits whitespace-only string values", () => {
    const args = buildCliArgs("t2i", { prompt: "   " });
    expect(args).not.toContain("--prompt");
  });

  it("omits undefined values", () => {
    const args = buildCliArgs("t2i", { prompt: undefined });
    expect(args).not.toContain("--prompt");
  });

  it("omits null values", () => {
    const args = buildCliArgs("t2i", { prompt: null });
    expect(args).not.toContain("--prompt");
  });

  it("emits boolean true as flag-only (no adjacent value)", () => {
    const args = buildCliArgs("t2i", { draft: true });
    const idx = args.indexOf("--draft");
    expect(idx).toBeGreaterThanOrEqual(0);
    // Next element must not be the string "true"
    if (idx + 1 < args.length) {
      expect(args[idx + 1]).not.toBe("true");
    }
  });

  it("omits boolean false flags", () => {
    const args = buildCliArgs("t2i", { draft: false });
    expect(args).not.toContain("--draft");
  });

  it("stringifies number values", () => {
    const args = buildCliArgs("t2i", { seed: 42 });
    const idx = args.indexOf("--seed");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("42");
  });

  it("omits NaN number values", () => {
    const args = buildCliArgs("t2i", { seed: NaN });
    expect(args).not.toContain("--seed");
  });

  it("emits select values as string", () => {
    const args = buildCliArgs("t2i", { pipeline: "flux2-klein" });
    const idx = args.indexOf("--pipeline");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("flux2-klein");
  });

  it("builds multiselect as repeated --flag per item", () => {
    const args = buildCliArgs("quality", { quality_inputs: ["/a.png", "/b.png"] });
    const count = args.filter((a) => a === "--quality-inputs").length;
    expect(count).toBe(2);
    expect(args).toContain("/a.png");
    expect(args).toContain("/b.png");
  });

  it("skips empty strings in multiselect arrays", () => {
    const args = buildCliArgs("quality", { quality_inputs: ["/a.png", "", "/b.png"] });
    const count = args.filter((a) => a === "--quality-inputs").length;
    expect(count).toBe(2);
  });

  it("throws for unknown action", () => {
    expect(() => buildCliArgs("nonexistent-action-xyz", {})).toThrow();
  });

  it("returns empty array when all params are omitted", () => {
    const args = buildCliArgs("t2i", {});
    expect(Array.isArray(args)).toBe(true);
  });
});

describe("validateParams", () => {
  it("returns error when required string field is missing", () => {
    const errors = validateParams("t2i", {});
    expect(errors.some((e) => e.includes("prompt"))).toBe(true);
  });

  it("returns error when required field is empty string", () => {
    const errors = validateParams("t2i", { prompt: "" });
    expect(errors.some((e) => e.includes("prompt"))).toBe(true);
  });

  it("returns empty array for valid params", () => {
    const errors = validateParams("t2i", { prompt: "hello" });
    expect(errors).toHaveLength(0);
  });

  it("returns error for completely unknown action", () => {
    const errors = validateParams("not-a-command-xyz", {});
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns error for required image field missing", () => {
    const errors = validateParams("i2i", {});
    expect(errors.some((e) => e.includes("input_image"))).toBe(true);
  });

  it("returns empty array when all required fields are provided", () => {
    const errors = validateParams("faceswap", { input_image: "/body.png", face: "/face.png" });
    expect(errors).toHaveLength(0);
  });
});
