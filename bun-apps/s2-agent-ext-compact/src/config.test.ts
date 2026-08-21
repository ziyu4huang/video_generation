import { describe, expect, test } from "bun:test";
import { loadCompactConfig } from "./config.ts";

describe("loadCompactConfig", () => {
  test("defaults: enabled, no override, 0.8 factor", () => {
    const c = loadCompactConfig({});
    expect(c.enabled).toBe(true);
    expect(c.modelOverrideSpec).toBeUndefined();
    expect(c.maxTokensFactor).toBe(0.8);
  });

  test("BUN_PI_COMPACT=0 disables", () => {
    expect(loadCompactConfig({ BUN_PI_COMPACT: "0" }).enabled).toBe(false);
    expect(loadCompactConfig({ BUN_PI_COMPACT: "1" }).enabled).toBe(true);
  });

  test("COMPACT_MODEL override, trimmed, empty means unset", () => {
    expect(loadCompactConfig({ COMPACT_MODEL: "zai/glm-5.3" }).modelOverrideSpec).toBe("zai/glm-5.3");
    expect(loadCompactConfig({ COMPACT_MODEL: "   " }).modelOverrideSpec).toBeUndefined();
  });

  test("COMPACT_MAX_TOKENS_FACTOR clamped to [0.1, 1]", () => {
    expect(loadCompactConfig({ COMPACT_MAX_TOKENS_FACTOR: "0.5" }).maxTokensFactor).toBe(0.5);
    expect(loadCompactConfig({ COMPACT_MAX_TOKENS_FACTOR: "9" }).maxTokensFactor).toBe(1);
    expect(loadCompactConfig({ COMPACT_MAX_TOKENS_FACTOR: "0" }).maxTokensFactor).toBe(0.1);
    expect(loadCompactConfig({ COMPACT_MAX_TOKENS_FACTOR: "junk" }).maxTokensFactor).toBe(0.8);
  });
});
