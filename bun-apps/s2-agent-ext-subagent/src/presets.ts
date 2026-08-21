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
import type { ModelTierConfig } from "@repo/s2-agent-core-runtime";

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
 * Built-in presets. Model ids are verified against the models-store catalog
 * (`validateConfigSpecs` in models-registry-reader.ts gates apply-time). A
 * preset's provider still needs its API key configured separately — runtime
 * auth is out of scope for preset validation.
 */

/** Shared vision capability block: single local model across all vision tiers
 *  (vision / vision-large / vision-medium / vision-small). Users can re-point
 *  individual tiers later — resolveModelRole falls back to `vision` when a
 *  tiered key isn't set, so this four-key shape is the discoverable default. */
const LMSTUDIO_VISION_CAPS = {
  vision: "lm-studio/google/gemma-4-12b",
  "vision-large": "lm-studio/google/gemma-4-12b",
  "vision-medium": "lm-studio/google/gemma-4-12b",
  "vision-small": "lm-studio/google/gemma-4-12b",
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "glm-lmstudio",
    label: "GLM (official) + LM Studio vision",
    summary: "tiers: glm-4.7 / glm-5.3  ·  vision tiers (large/mid/small): lm-studio gemma-4-12b",
    config: {
      tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
      capabilities: { ...LMSTUDIO_VISION_CAPS },
    },
  },
  {
    id: "deepseek-pro",
    label: "DeepSeek pro (official) + LM Studio vision",
    summary: "tiers: gemma-4-12b / flash / pro  ·  vision tiers: lm-studio gemma-4-12b",
    config: {
      tiers: {
        small: "lm-studio/google/gemma-4-12b",
        medium: "deepseek/deepseek-v4-flash",
        big: "deepseek/deepseek-v4-pro",
      },
      capabilities: { ...LMSTUDIO_VISION_CAPS },
    },
  },
  {
    id: "deepseek-flash",
    label: "DeepSeek flash (official) + LM Studio vision",
    summary: "tiers: gemma-4-12b / gemma-4-12b / flash  ·  vision tiers: lm-studio gemma-4-12b",
    config: {
      tiers: {
        small: "lm-studio/google/gemma-4-12b",
        medium: "lm-studio/google/gemma-4-12b",
        big: "deepseek/deepseek-v4-flash",
      },
      capabilities: { ...LMSTUDIO_VISION_CAPS },
    },
  },
];

/** Look up a preset by id. */
export function findPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}
