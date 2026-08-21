import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getEffectiveModelTierConfig,
  getTransientModelTierConfig,
  loadModelTierConfig,
  type ModelTierConfig,
  resolveModelRole,
  resolveTierModel,
  saveModelTierConfig,
  setTransientModelTierConfig,
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

// ─── Transient (session-scope) override — ADR-subagent-0006 ──────────────────
// `/models-preset` applies presets TRANSIENTLY: the override lives in process
// memory only and RESOLUTION reads it ahead of the on-disk file, while
// loadModelTierConfig() stays FILE-ONLY (the /workflows-models editor shows
// exactly what a save would write). These tests pin both halves so a
// regression to persistent writes (or a leak into the file reader) fails
// loudly.

const PRESET_LIKE: ModelTierConfig = {
  tiers: { small: "fake/small-m", medium: "fake/medium-m", big: "fake/big-m" },
};

test("transient override: resolution reads it ahead of the file; clearing restores", () => {
  const before = loadModelTierConfig(); // machine state, whatever it is
  setTransientModelTierConfig(PRESET_LIKE);

  expect(getTransientModelTierConfig()).toEqual(PRESET_LIKE);
  expect(getEffectiveModelTierConfig()).toEqual(PRESET_LIKE);
  // The override actually steers role resolution, not just the getter.
  expect(resolveModelRole({ tier: "big" }, getEffectiveModelTierConfig())).toBe("fake/big-m");
  expect(resolveTierModel("small", getEffectiveModelTierConfig())).toBe("fake/small-m");

  setTransientModelTierConfig(null);
  // Clearing restores the file view exactly (comparative — machine-agnostic).
  expect(getEffectiveModelTierConfig()).toEqual(before);
  expect(getTransientModelTierConfig()).toBeNull();
});

test("transient override: loadModelTierConfig stays FILE-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "tier-transient-"));
  try {
    const p = join(dir, "model-tiers.json");
    writeFileSync(p, JSON.stringify({ tiers: { medium: "file/medium-m" } }));

    setTransientModelTierConfig(PRESET_LIKE);
    expect(loadModelTierConfig(p)).toEqual({ tiers: { medium: "file/medium-m" } });
    expect(getEffectiveModelTierConfig()).toEqual(PRESET_LIKE);
    // No explicit path: the file reader still reports the real file (glm preset
    // on this machine, null on a clean CI box) — never the override.
    expect(loadModelTierConfig()).not.toEqual(PRESET_LIKE);
  } finally {
    setTransientModelTierConfig(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
