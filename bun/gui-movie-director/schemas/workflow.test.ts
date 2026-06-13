import { describe, it, expect } from "bun:test";
import { workflowCommand } from "./workflow";
import { invariants } from "./test-helpers";

invariants(workflowCommand);

describe("workflow: isDisabled", () => {
  it("is disabled when prompt is absent", () => {
    expect(workflowCommand.isDisabled!({})).toBe(true);
  });

  it("is disabled when prompt is whitespace only", () => {
    expect(workflowCommand.isDisabled!({ prompt: "   " })).toBe(true);
  });

  it("is enabled when prompt has content", () => {
    expect(workflowCommand.isDisabled!({ prompt: "portrait" })).toBe(false);
  });
});

describe("workflow: buildParams", () => {
  const base = { prompt: " a portrait ", pipeline: "zimage", width: 640, height: 960, seed: 42, face_detail: false, film_grain: 0, sharpening: 0, upscale: false };

  it("trims prompt", () => {
    const r = workflowCommand.buildParams!(base);
    expect(r.prompt).toBe("a portrait");
  });

  it("includes pipeline, width, height, seed", () => {
    const r = workflowCommand.buildParams!(base);
    expect(r.pipeline).toBe("zimage");
    expect(r.width).toBe(640);
    expect(r.height).toBe(960);
    expect(r.seed).toBe(42);
  });

  it("omits face_detail when falsy", () => {
    const r = workflowCommand.buildParams!({ ...base, face_detail: false });
    expect(r.face_detail).toBeUndefined();
  });

  it("includes face_detail when true", () => {
    const r = workflowCommand.buildParams!({ ...base, face_detail: true });
    expect(r.face_detail).toBe(true);
  });

  it("omits film_grain when 0", () => {
    const r = workflowCommand.buildParams!({ ...base, film_grain: 0 });
    expect(r.film_grain).toBeUndefined();
  });

  it("includes film_grain when > 0", () => {
    const r = workflowCommand.buildParams!({ ...base, film_grain: 0.3 });
    expect(r.film_grain).toBe(0.3);
  });

  it("omits sharpening when 0", () => {
    const r = workflowCommand.buildParams!({ ...base, sharpening: 0 });
    expect(r.sharpening).toBeUndefined();
  });

  it("includes sharpening when > 0", () => {
    const r = workflowCommand.buildParams!({ ...base, sharpening: 0.5 });
    expect(r.sharpening).toBe(0.5);
  });

  it("omits upscale when falsy", () => {
    const r = workflowCommand.buildParams!({ ...base, upscale: false });
    expect(r.upscale).toBeUndefined();
  });

  it("includes upscale when true", () => {
    const r = workflowCommand.buildParams!({ ...base, upscale: true });
    expect(r.upscale).toBe(true);
  });
});
