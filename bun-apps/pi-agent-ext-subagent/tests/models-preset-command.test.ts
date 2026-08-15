/**
 * /models-preset command — apply logic (dependency-injected config I/O).
 *
 * Verifies: direct-apply writes the preset's full {tiers, capabilities}, the
 * prior file is backed up to .bak, and an unknown id notifies an error.
 *
 * Uses DI (not mock.module) so the test does NOT leak a model-role-config mock
 * into sibling test files under bun's shared-realm default.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelTierConfig } from "@repo/pi-agent-ext-core-runtime";
import { createModelsPresetCommand } from "../extensions/models-preset.js";

let tmpDir: string;
let configPath: string;
let savedConfig: ModelTierConfig | null = null;
let existingConfig: ModelTierConfig | null = null;

/** Build a handler with config I/O pointed at the temp path (no real disk hit). */
function makeHandler() {
  return createModelsPresetCommand({
    getConfigPath: () => configPath,
    loadConfig: () => existingConfig,
    saveConfig: (cfg: ModelTierConfig) => {
      savedConfig = cfg;
    },
  });
}

function fakeCtx(overrides: { confirm?: boolean; select?: string | null } = {}) {
  const calls: { confirm: { title: string; msg: string }[]; notify: { msg: string; level: string }[] } = {
    confirm: [],
    notify: [],
  };
  return {
    calls,
    ctx: {
      ui: {
        confirm: async (title: string, msg: string) => {
          calls.confirm.push({ title, msg });
          return overrides.confirm ?? true;
        },
        select: async (_title: string, _options: string[]) => overrides.select ?? null,
        notify: (msg: string, level: string) => calls.notify.push({ msg, level }),
      },
    } as any,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "models-preset-"));
  configPath = join(tmpDir, "model-tiers.json");
  savedConfig = null;
  existingConfig = null;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("/models-preset", () => {
  test("direct apply writes the preset config + backs up the prior file", async () => {
    writeFileSync(configPath, JSON.stringify({ tiers: { small: "old/x" } }));
    existingConfig = { tiers: { small: "old/x" } };

    const { ctx, calls } = fakeCtx({ confirm: true });
    await makeHandler()("glm-lmstudio", ctx);

    expect(savedConfig).toEqual({
      tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.2", big: "zai/glm-5.2" },
      capabilities: { vision: "lm-studio/google/gemma-4-12b" },
    });
    expect(calls.confirm).toHaveLength(1);
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    expect(calls.notify[0]?.level).toBe("info");
    expect(calls.notify[0]?.msg).toContain("GLM");
  });

  test("unknown preset id notifies an error + lists available", async () => {
    const { ctx, calls } = fakeCtx();
    await makeHandler()("bogus", ctx);
    expect(savedConfig).toBeNull();
    expect(calls.notify[0]?.level).toBe("error");
    expect(calls.notify[0]?.msg).toContain("bogus");
    expect(calls.notify[0]?.msg).toContain("glm-lmstudio");
  });

  test("no existing config → no confirm, no backup, just save", async () => {
    existingConfig = null;
    const { ctx, calls } = fakeCtx();
    await makeHandler()("deepseek-lmstudio", ctx);
    expect(savedConfig).toEqual({
      tiers: {
        small: "deepseek/deepseek-v4-flash",
        medium: "deepseek/deepseek-v4-pro",
        big: "deepseek/deepseek-v4-pro",
      },
      capabilities: { vision: "lm-studio/google/gemma-4-12b" },
    });
    expect(calls.confirm).toHaveLength(0);
    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });

  test("confirm cancelled → nothing saved", async () => {
    writeFileSync(configPath, JSON.stringify({ tiers: { small: "old/x" } }));
    existingConfig = { tiers: { small: "old/x" } };
    const { ctx } = fakeCtx({ confirm: false });
    await makeHandler()("glm-lmstudio", ctx);
    expect(savedConfig).toBeNull();
  });
});
