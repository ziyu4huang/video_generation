/**
 * ensure-model-tiers — unit tests for the pure helpers in pre-load-providers.ts (§3).
 *
 * The import-time side effect (writing ~/.pi/workflows/model-tiers.json) is
 * intentionally NOT tested here; it would mutate the user's live config. We test
 * the pure serialization + decision helpers instead. Mirrors the
 * subagent-model-floor.test.ts split (pure helper vs import-time wrapper).
 */
import { describe, expect, test } from "bun:test";
// The pure helpers live in pre-load-providers.ts (no side effects); the patch
// module (ensure-model-tiers.ts) only IMPORTS them. So we import the helpers
// from where they are defined — same split as subagent-model-floor.test.ts,
// which imports resolveSubagentFloor from the module that defines it.
import {
  DEFAULT_MODEL_TIER_CONFIG,
  buildModelTiersJson,
  shouldEnsureModelTiers,
} from "../pre-load-providers.ts";

describe("buildModelTiersJson — serializes the default config", () => {
  test("contains the glm-lmstudio tier ids", () => {
    const json = buildModelTiersJson();
    expect(json).toContain("zai/glm-4.7");
expect(json).toContain("zai/glm-5.3");
    expect(json).toContain("lm-studio/google/gemma-4-12b");  });

  test("parses back to a structurally-equal config object", () => {
    const json = buildModelTiersJson();
    expect(JSON.parse(json)).toEqual(DEFAULT_MODEL_TIER_CONFIG);
  });

  test("appends a trailing newline (file-style)", () => {
    expect(buildModelTiersJson().endsWith("\n")).toBe(true);
  });

  test("serializes a passed-in config, not just the default", () => {
    const custom = {
      tiers: { small: "a", medium: "b", big: "c" },
      capabilities: { vision: "d" },
    };
    expect(JSON.parse(buildModelTiersJson(custom))).toEqual(custom);
  });
});

describe("shouldEnsureModelTiers — write decision", () => {
  test("absent file + enabled → write", () => {
    expect(shouldEnsureModelTiers({ fileExists: false, enabled: true })).toBe(true);
  });

  test("existing file + enabled → NO write (never clobber)", () => {
    expect(shouldEnsureModelTiers({ fileExists: true, enabled: true })).toBe(false);
  });

  test("absent file + disabled → NO write", () => {
    expect(shouldEnsureModelTiers({ fileExists: false, enabled: false })).toBe(false);
  });

  test("existing file + disabled → NO write", () => {
    expect(shouldEnsureModelTiers({ fileExists: true, enabled: false })).toBe(false);
  });
});

describe("DEFAULT_MODEL_TIER_CONFIG — shape", () => {
  test("tiers has exactly small/medium/big", () => {
    expect(Object.keys(DEFAULT_MODEL_TIER_CONFIG.tiers).sort()).toEqual([
      "big",
      "medium",
      "small",
    ]);
  });

  test("capabilities.vision is set", () => {
    expect(typeof DEFAULT_MODEL_TIER_CONFIG.capabilities.vision).toBe("string");
    expect(DEFAULT_MODEL_TIER_CONFIG.capabilities.vision.length).toBeGreaterThan(0);
  });

  test("capabilities includes tiered vision keys", () => {
    for (const key of ["vision-large", "vision-medium", "vision-small"]) {
      expect(typeof DEFAULT_MODEL_TIER_CONFIG.capabilities[key]).toBe("string");
      expect(DEFAULT_MODEL_TIER_CONFIG.capabilities[key]!.length).toBeGreaterThan(0);
    }
  });
});
