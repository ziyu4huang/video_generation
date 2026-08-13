import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ModelTierConfig } from "@repo/pi-agent-ext-core-runtime";
import { TIERED_TOKEN_BUDGET_DEFAULTS, tierDefaultToken } from "../src/budget-defaults.js";

const CFG: ModelTierConfig = {
  tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.2", big: "zai/glm-5.2-thinking" },
};

test("TIERED_TOKEN_BUDGET_DEFAULTS: p90-calibrated ceilings", () => {
  assert.equal(TIERED_TOKEN_BUDGET_DEFAULTS.small, 500_000);
  assert.equal(TIERED_TOKEN_BUDGET_DEFAULTS.medium, 1_200_000);
  assert.equal(TIERED_TOKEN_BUDGET_DEFAULTS.big, 1_500_000);
});

test("tierDefaultToken: explicit tier → that tier's ceiling", () => {
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  assert.equal(tierDefaultToken("medium", undefined, CFG), 1_200_000);
  assert.equal(tierDefaultToken("big", undefined, CFG), 1_500_000);
  // tier wins over model when both are given
  assert.equal(tierDefaultToken("small", "zai/glm-5.2", CFG), 500_000);
});

test("tierDefaultToken: unset tier → reverse-map model→tier via config", () => {
  assert.equal(tierDefaultToken(undefined, "zai/glm-4.7", CFG), 500_000); // glm-4.7 → small
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2", CFG), 1_200_000); // glm-5.2 → medium
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2-thinking", CFG), 1_500_000); // → big
  // strip a :thinking suffix before matching
  assert.equal(tierDefaultToken(undefined, "zai/glm-4.7:thinking", CFG), 500_000);
});

test("tierDefaultToken: unknown model + unset tier → medium ceiling (safe fallback)", () => {
  assert.equal(tierDefaultToken(undefined, "deepseek/unknown-model", CFG), 1_200_000);
});

test("tierDefaultToken: no config at all → medium ceiling (safe fallback)", () => {
  assert.equal(tierDefaultToken(undefined, "zai/glm-4.7", null), 1_200_000);
  assert.equal(tierDefaultToken(undefined, undefined, null), 1_200_000);
});

test("tierDefaultToken: unknown tier name → medium ceiling", () => {
  assert.equal(tierDefaultToken("humongous", undefined, CFG), 1_200_000);
});
