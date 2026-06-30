import { invariants } from "./test-helpers";
import { profileCommand } from "./profile";

invariants(profileCommand);

describe("profile: isDisabled", () => {
  const { isDisabled } = profileCommand;

  it("is disabled when prompt is undefined", () => {
    expect(isDisabled!({})).toBe(true);
  });

  it("is disabled when prompt is empty string", () => {
    expect(isDisabled!({ prompt: "" })).toBe(true);
  });

  it("is disabled when prompt is whitespace-only", () => {
    expect(isDisabled!({ prompt: "   " })).toBe(true);
  });

  it("is enabled when prompt has non-whitespace content", () => {
    expect(isDisabled!({ prompt: "a brave knight" })).toBe(false);
  });

  it("is enabled when prompt has leading/trailing whitespace but non-empty content", () => {
    expect(isDisabled!({ prompt: "  hero  " })).toBe(false);
  });
});

describe("profile: buildParams", () => {
  const { buildParams } = profileCommand;

  it("includes trimmed prompt and default fields", () => {
    const result = buildParams!({ prompt: "  warrior  ", views: "front", ratio: "standing", seed: 42 });
    expect(result.prompt).toBe("warrior");
    expect(result.views).toBe("front");
    expect(result.ratio).toBe("standing");
    expect(result.seed).toBe(42);
  });

  it("omits base_prompt when it is empty string", () => {
    const result = buildParams!({ prompt: "hero", base_prompt: "" });
    expect(result.base_prompt).toBeUndefined();
  });

  it("omits base_prompt when it is whitespace-only", () => {
    const result = buildParams!({ prompt: "hero", base_prompt: "   " });
    expect(result.base_prompt).toBeUndefined();
  });

  it("includes base_prompt when it has content", () => {
    const result = buildParams!({ prompt: "hero", base_prompt: "  photographic  " });
    expect(result.base_prompt).toBe("photographic");
  });

  it("omits ref_count when it equals the default value of 3", () => {
    const result = buildParams!({ prompt: "hero", ref_count: 3 });
    expect(result.ref_count).toBeUndefined();
  });

  it("includes ref_count when it differs from the default value of 3", () => {
    const result = buildParams!({ prompt: "hero", ref_count: 1 });
    expect(result.ref_count).toBe(1);
  });
});
