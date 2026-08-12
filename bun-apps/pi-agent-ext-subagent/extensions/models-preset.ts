/**
 * `/models-preset` command handler.
 *
 * Applies a named model-config preset (text-LLM tiers + the always-local vision
 * capability) to ~/.pi/workflows/model-tiers.json. The preset definitions live
 * in src/presets.ts (the one place specific model ids may appear — as templates).
 *
 * Usage:
 *   /models-preset              → interactive picker
 *   /models-preset <id>         → apply <id> directly (e.g. glm-lmstudio)
 *
 * The prior config is backed up to <path>.bak before overwriting.
 *
 * Config I/O is dependency-injected (defaults to the real model-role-config
 * functions) so the command is unit-testable WITHOUT mock.module (which would
 * leak across test files under bun's shared-realm default).
 */
import { existsSync, renameSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelTierConfig } from "@repo/pi-agent-ext-core-runtime";
import { getModelTierConfigPath, loadModelTierConfig, saveModelTierConfig } from "@repo/pi-agent-ext-core-runtime";
import { findPreset, MODEL_PRESETS } from "../src/presets.js";

/** Injectable config I/O (defaults hit the real ~/.pi/workflows/model-tiers.json). */
export interface PresetCommandDeps {
  getConfigPath?: () => string;
  loadConfig?: () => ModelTierConfig | null;
  saveConfig?: (cfg: ModelTierConfig) => void;
}

/** Build the command handler (factory, mirroring createSubagentsCommand). */
export function createModelsPresetCommand(deps: PresetCommandDeps = {}) {
  const getConfigPath = deps.getConfigPath ?? getModelTierConfigPath;
  const loadConfig = deps.loadConfig ?? loadModelTierConfig;
  const saveConfig = deps.saveConfig ?? saveModelTierConfig;

  /** Write a preset's config to disk (with .bak backup of the prior file). */
  async function applyPreset(
    preset: (typeof MODEL_PRESETS)[number],
    ctx: ExtensionCommandContext,
    confirm: boolean,
  ): Promise<void> {
    const configPath = getConfigPath();
    const existing = loadConfig();

    if (confirm && existing) {
      const ok = await ctx.ui.confirm(
        `Apply preset "${preset.label}"?`,
        `This replaces ${configPath} (the prior file is kept as .bak).`,
      );
      if (!ok) return;
    }

    if (existsSync(configPath)) {
      try {
        renameSync(configPath, `${configPath}.bak`);
      } catch {
        // best-effort backup; saveConfig writes regardless
      }
    }
    saveConfig(preset.config);
    ctx.ui.notify(`Applied "${preset.label}" → ${configPath}${existing ? " (prior → .bak)" : ""}`, "info");
  }

  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    // Direct apply: /models-preset <id>  (Pi passes the raw arg string.)
    const directId = args.trim();
    if (directId) {
      const preset = findPreset(directId);
      if (!preset) {
        ctx.ui.notify(`Unknown preset "${directId}". Available: ${MODEL_PRESETS.map((p) => p.id).join(", ")}`, "error");
        return;
      }
      await applyPreset(preset, ctx, true);
      return;
    }

    // Interactive picker.
    const options = MODEL_PRESETS.map((p) => `${p.id}  —  ${p.summary}`);
    const sel = await ctx.ui.select("Apply a model-config preset", options);
    if (!sel) return;
    const chosen = MODEL_PRESETS.find((p) => sel.startsWith(p.id));
    if (!chosen) return;
    await applyPreset(chosen, ctx, true);
  };
}

/** Register the `/models-preset` command with Pi. */
export function registerModelsPresetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("models-preset", {
    description: "Apply a model-config preset (text-LLM tiers + vision) to ~/.pi/workflows/model-tiers.json",
    handler: createModelsPresetCommand(),
  });
}
