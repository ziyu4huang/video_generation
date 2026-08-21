import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModelTierConfig,
  type ModelTierConfig,
  resolveModelRole,
  resolveTierModel,
  saveModelTierConfig,
} from "@repo/s2-agent-core-runtime";

function tmpConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "model-role-"));
  const p = join(dir, "model-tiers.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

test("loadModelTierConfig loads tiers + capabilities", () => {
  const p = tmpConfig({ tiers: { small: "openai/gpt-4.1-mini" }, capabilities: { vision: "lmstudio/qwen-vl" } });
  const cfg = loadModelTierConfig(p);
  expect(cfg?.tiers.small).toBe("openai/gpt-4.1-mini");
  expect(cfg?.capabilities?.vision).toBe("lmstudio/qwen-vl");
});

test("loadModelTierConfig accepts legacy tiers-only file (backward compat)", () => {
  const p = tmpConfig({ tiers: { small: "openai/x", medium: "openai/y" } });
  const cfg = loadModelTierConfig(p);
  expect(cfg?.capabilities).toBeUndefined();
  expect(resolveTierModel("medium", cfg!)).toBe("openai/y");
});

test("loadModelTierConfig rejects non-string capability values", () => {
  const p = tmpConfig({ tiers: { small: "openai/x" }, capabilities: { vision: 123 } });
  expect(loadModelTierConfig(p)).toBeNull();
});

test("resolveModelRole resolves a capability", () => {
  const cfg: ModelTierConfig = { tiers: { small: "a" }, capabilities: { vision: "lmstudio/v" } };
  expect(resolveModelRole({ capability: "vision" }, cfg)).toBe("lmstudio/v");
});

test("resolveModelRole resolves a tier", () => {
  const cfg: ModelTierConfig = { tiers: { small: "a" } };
  expect(resolveModelRole({ tier: "small" }, cfg)).toBe("a");
});

test("resolveModelRole returns undefined for unconfigured capability", () => {
  const cfg: ModelTierConfig = { tiers: { small: "a" } };
  expect(resolveModelRole({ capability: "vision" }, cfg)).toBeUndefined();
});

test("resolveModelRole returns undefined when config is null", () => {
  expect(resolveModelRole({ capability: "vision" }, null)).toBeUndefined();
});

test("saveModelTierConfig round-trips capabilities", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-role-"));
  const p = join(dir, "model-tiers.json");
  saveModelTierConfig({ tiers: { small: "a" }, capabilities: { vision: "v" } }, p);
  const cfg = loadModelTierConfig(p);
  expect(cfg?.capabilities?.vision).toBe("v");
});

// --- dashed-capability fallback (vision tiers) ---

const TIER_CFG: ModelTierConfig = {
  tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
  capabilities: { vision: "lm-studio/google/gemma-4-12b" },
};

const TIERED_CFG: ModelTierConfig = {
  ...TIER_CFG,
  capabilities: {
    vision: "lm-studio/google/gemma-4-12b",
    "vision-large": "lm-studio/google/gemma-4-27b",
  },
};

test("resolveModelRole: vision-large falls back to vision when tiered key absent", () => {
  expect(resolveModelRole({ capability: "vision-large" }, TIER_CFG)).toBe("lm-studio/google/gemma-4-12b");
});

test("resolveModelRole: exact tiered key wins over vision fallback", () => {
  expect(resolveModelRole({ capability: "vision-large" }, TIERED_CFG)).toBe("lm-studio/google/gemma-4-27b");
});

test("resolveModelRole: vision-medium falls back when only vision-large is tiered", () => {
  expect(resolveModelRole({ capability: "vision-medium" }, TIERED_CFG)).toBe("lm-studio/google/gemma-4-12b");
});

test("resolveModelRole: vision-small falls back to vision", () => {
  expect(resolveModelRole({ capability: "vision-small" }, TIER_CFG)).toBe("lm-studio/google/gemma-4-12b");
});

test("resolveModelRole: unknown dashed capability still falls back once (vision-x → vision)", () => {
  expect(resolveModelRole({ capability: "vision-x" }, TIER_CFG)).toBe("lm-studio/google/gemma-4-12b");
  expect(resolveModelRole({ capability: "audio-large" }, TIER_CFG)).toBeUndefined();
});
