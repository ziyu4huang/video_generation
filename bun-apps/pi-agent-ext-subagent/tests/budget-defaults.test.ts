import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import type { ModelTierConfig } from "@repo/pi-agent-ext-core-runtime";
import {
  ROLE_AWARE_DISPATCH_BOUNDS,
  roleAwareDefaults,
  TIERED_TOKEN_BUDGET_DEFAULTS,
  tierDefaultToken,
} from "../src/budget-defaults.js";

const ENV_KNOBS = [
  "SUBAGENT_TOKEN_BUDGET_DISABLE",
  "SUBAGENT_TOKEN_BUDGET_SMALL",
  "SUBAGENT_TOKEN_BUDGET_MEDIUM",
  "SUBAGENT_TOKEN_BUDGET_BIG",
  "SUBAGENT_TOKEN_BUDGET_MULTIPLIER",
] as const;

// Save/restore every knob so tests are hermetic against the ambient env.
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KNOBS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KNOBS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

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

test("env knobs: per-tier absolute override replaces the resolved tier's ceiling", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "700000";
  assert.equal(tierDefaultToken("small", undefined, CFG), 700_000);
  // override applies to the RESOLVED tier — here medium via model mapping
  process.env.SUBAGENT_TOKEN_BUDGET_MEDIUM = "999999";
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2", CFG), 999_999);
  // other tiers unaffected
  assert.equal(tierDefaultToken("big", undefined, CFG), 1_500_000);
});

test("env knobs: multiplier scales the table default", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = "2";
  assert.equal(tierDefaultToken("small", undefined, CFG), 1_000_000);
  assert.equal(tierDefaultToken("medium", undefined, CFG), 2_400_000);
});

test("env knobs: multiplier applies AFTER the absolute override", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "300000";
  process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = "1.5";
  assert.equal(tierDefaultToken("small", undefined, CFG), 450_000);
});

test("env knobs: multiplier floors fractional results (clamp)", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = "1.000001";
  // 500_000 * 1.000001 = 500_000.5 → floor → 500_000
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
});

test(`env knobs: DISABLE="1" or "true" (case-insensitive) → undefined (no budget)`, () => {
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1";
  assert.equal(tierDefaultToken("small", undefined, CFG), undefined);
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "true";
  assert.equal(tierDefaultToken(undefined, "zai/glm-5.2", CFG), undefined);
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "TRUE";
  assert.equal(tierDefaultToken("big", undefined, CFG), undefined);
  // disable wins over overrides/multiplier too
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "700000";
  process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = "2";
  assert.equal(tierDefaultToken("small", undefined, CFG), undefined);
});

test("env knobs: invalid per-tier values are silently ignored", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "abc";
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "0"; // not positive
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "-2";
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  process.env.SUBAGENT_TOKEN_BUDGET_SMALL = "1.5"; // not an integer
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
});

test("env knobs: invalid multiplier values are silently ignored", () => {
  for (const bad of ["abc", "0", "-2", ""]) {
    process.env.SUBAGENT_TOKEN_BUDGET_MULTIPLIER = bad;
    assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
  }
});

test("env knobs: disable flag with an invalid value is ignored (still budgeted)", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "yes";
  assert.equal(tierDefaultToken("small", undefined, CFG), 500_000);
});

// ── #03 role-aware dispatch bounds (2026-08-15 hardening) ──

test("ROLE_AWARE_DISPATCH_BOUNDS: recon 60k/8/5min, writer 400k/24/20min", () => {
  assert.deepEqual(ROLE_AWARE_DISPATCH_BOUNDS.recon, { tokenBudget: 60_000, maxTurns: 8, timeoutMs: 300_000 });
  assert.deepEqual(ROLE_AWARE_DISPATCH_BOUNDS.writer, { tokenBudget: 400_000, maxTurns: 24, timeoutMs: 1_200_000 });
});

test("roleAwareDefaults: all-omitted recon → full envelope + notice", () => {
  const d = roleAwareDefaults({}, "recon");
  assert.equal(d.applied, true);
  assert.equal(d.tokenBudget, 60_000);
  assert.equal(d.maxTurns, 8);
  assert.equal(d.timeoutMs, 300_000);
  assert.match(d.notice ?? "", /defaults applied \(recon\)/);
});

test("roleAwareDefaults: all-omitted writer → full envelope + notice", () => {
  const d = roleAwareDefaults({}, "writer");
  assert.equal(d.applied, true);
  assert.deepEqual(
    { tokenBudget: d.tokenBudget, maxTurns: d.maxTurns, timeoutMs: d.timeoutMs },
    { tokenBudget: 400_000, maxTurns: 24, timeoutMs: 1_200_000 },
  );
  assert.match(d.notice ?? "", /defaults applied \(writer\)/);
});

test("roleAwareDefaults: ANY explicit bound (some- or all-passed) opts the whole envelope out", () => {
  assert.equal(roleAwareDefaults({ tokenBudget: 5 }, "recon").applied, false);
  assert.equal(roleAwareDefaults({ maxTurns: 3 }, "recon").applied, false);
  assert.equal(roleAwareDefaults({ timeoutMs: 1_000 }, "recon").applied, false);
  const all = roleAwareDefaults({ tokenBudget: 5, maxTurns: 3, timeoutMs: 1_000 }, "writer");
  assert.equal(all.applied, false);
  assert.equal(all.tokenBudget, undefined);
  assert.equal(all.maxTurns, undefined);
  assert.equal(all.timeoutMs, undefined);
});

test("roleAwareDefaults: SUBAGENT_TOKEN_BUDGET_DISABLE=1 escapes entirely", () => {
  process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1";
  assert.equal(roleAwareDefaults({}, "recon").applied, false);
  assert.equal(roleAwareDefaults({}, "writer").applied, false);
});

test("roleAwareDefaults: recon ceiling is min(60k, tierCeiling); writer ignores it", () => {
  assert.equal(roleAwareDefaults({}, "recon", 40_000).tokenBudget, 40_000);
  assert.equal(roleAwareDefaults({}, "recon", 2_000_000).tokenBudget, 60_000);
  assert.equal(roleAwareDefaults({}, "writer", 40_000).tokenBudget, 400_000);
});
