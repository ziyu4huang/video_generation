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

  it("omits lora_scale when exactly 1.0", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 1.0, count: 1 });
    expect(result.lora_scale).toBeUndefined();
  });

  it("includes lora_scale when not 1.0", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 0.8, count: 1 });
    expect(result.lora_scale).toBe(0.8);
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

  it("omits steps when undefined", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 1.0, count: 1 });
    expect(result.steps).toBeUndefined();
  });

  it("includes steps when provided", () => {
    const result = fn({ prompt: "x", pipeline: "zimage", width: 640, height: 960, seed: 42, lora_scale: 1.0, count: 1, steps: 20 });
    expect(result.steps).toBe(20);
  });
});
