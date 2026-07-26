/**
 * presets.ts — named model-config templates for `/models-preset`.
 *
 * The ONE place specific model ids live in the subagent package — as labeled
 * TEMPLATES a user explicitly applies (which writes to their personal
 * ~/.pi/workflows/model-tiers.json). Resolution code (resolveTierModel /
 * resolveModelRole / file2md vision-inference) stays config-driven and
 * env-agnostic; these presets are setup-time convenience data, not runtime
 * defaults.
 *
 * Every preset pairs a text-LLM tier mapping with an always-local vision model,
 * because the text providers (glm, deepseek, …) cannot do vision — only the
 * local lm-studio runtime can. Switching text-LLM providers never touches vision.
 *
 * To add a provider: add one entry to MODEL_PRESETS below (data only).
 */
import type { ModelTierConfig } from "./model-role-config.js";

export interface ModelPreset {
  /** Stable id used on the command line / picker (kebab-case). */
  id: string;
  /** Human label. */
  label: string;
  /** One-line summary shown in the picker. */
  summary: string;
  /** The full config this preset applies. */
  config: ModelTierConfig;
}

/**
 * Built-in presets. `deepseek-lmstudio` model ids are a best-guess template —
 * the deepseek provider may not be configured in ~/.pi/agent/models.json yet;
 * correct the ids via `/workflows-models` after adding the provider.
 */
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "glm-lmstudio",
    label: "GLM (official) + LM Studio vision",
    summary: "tiers: glm-4.7 / glm-5.2  ·  vision: lm-studio gemma-4-12b",
    config: {
      tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.2", big: "zai/glm-5.2" },
      capabilities: { vision: "lm-studio/google/gemma-4-12b-qat" },
    },
  },
  {
    id: "deepseek-lmstudio",
    label: "DeepSeek (official) + LM Studio vision",
    summary: "tiers: deepseek-flash-v4 / deepseek-pro  ·  vision: lm-studio gemma-4-12b",
    config: {
      tiers: { small: "deepseek/deepseek-flash-v4", medium: "deepseek/deepseek-pro", big: "deepseek/deepseek-pro" },
      capabilities: { vision: "lm-studio/google/gemma-4-12b-qat" },
    },
  },
];

/** Look up a preset by id. */
export function findPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}
