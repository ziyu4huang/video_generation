/**
 * presets.ts — named model-config templates for `/models-preset`.
 *
 * The ONE place specific model ids live in the subagent package — as labeled
 * TEMPLATES a user explicitly applies. Resolution code (resolveTierModel /
 * resolveModelRole / file2md vision-inference) stays config-driven and
 * env-agnostic; these presets are switch-time convenience data, not runtime
 * defaults.
 *
 * TRANSIENT BY CONTRACT (ADR-subagent-0006): applying a preset switches the
 * CURRENT session only — main model via pi.setModel + tier/capability routing
 * via the in-memory transient override. It NEVER writes
 * ~/.pi/workflows/model-tiers.json (or anything else under ~/.pi); the only
 * writer of that file is the ensure-model-tiers startup seed of the built-in
 * default. Do not regress this to a persistent write.
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
 * Built-in presets. Model ids are resolved against the live model catalog at
 * apply time (ctx.modelRegistry.find — an unknown id is reported, not applied).
 * A preset's provider still needs its API key configured separately — runtime
 * auth is out of scope for preset application.
 */

/** Shared vision capability block: single local model across all vision tiers
 *  (vision / vision-large / vision-medium / vision-small). Users can re-point
 *  individual tiers later — resolveModelRole falls back to `vision` when a
 *  tiered key isn't set, so this four-key shape is the discoverable default.
 *  Mirrors s2-agent's DEFAULT_MODEL_TIER_CONFIG: bonsai-27b with the :off
 *  no-think pin (user directive 2026-08-24; the qwen id here had drifted and
 *  carried no :off — always-on reasoning burn on every vision call). */
const LMSTUDIO_VISION_CAPS = {
  vision: "lm-studio/prism-ml/bonsai-27b:off",
  "vision-large": "lm-studio/prism-ml/bonsai-27b:off",
  "vision-medium": "lm-studio/prism-ml/bonsai-27b:off",
  "vision-small": "lm-studio/prism-ml/bonsai-27b:off",
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "glm-lmstudio",
    label: "GLM (official) + LM Studio vision",
    summary: "tiers: glm-5.3-flash / glm-5.3  ·  vision tiers (large/mid/small): lm-studio bonsai-27b:off",
    config: {
      tiers: { small: "zai/glm-5.3-flash", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
      capabilities: { ...LMSTUDIO_VISION_CAPS },
    },
  },
  {
    id: "deepseek-pro",
    label: "DeepSeek pro (official) + LM Studio vision",
    summary: "tiers: bonsai-27b / flash / pro  ·  vision tiers: lm-studio bonsai-27b:off",
    config: {
      tiers: {
        small: "lm-studio/prism-ml/bonsai-27b",
        medium: "deepseek/deepseek-v4-flash",
        big: "deepseek/deepseek-v4-pro",
      },
      capabilities: { ...LMSTUDIO_VISION_CAPS },
    },
  },
  {
    id: "deepseek-flash",
    label: "DeepSeek flash (official) + LM Studio vision",
    summary: "tiers: bonsai-27b / bonsai-27b / flash  ·  vision tiers: lm-studio bonsai-27b:off",
    config: {
      tiers: {
        small: "lm-studio/prism-ml/bonsai-27b",
        medium: "lm-studio/prism-ml/bonsai-27b",
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

/**
 * The model the MAIN session switches to when this preset is applied.
 *
 * `big` is the preset's headline model in every built-in preset (the name a
 * user reads in the label — "DeepSeek pro" → deepseek-v4-pro); small/medium
 * exist for subagent routing. The fallback chain only exists so a future
 * hand-written preset missing `big` still resolves to SOMETHING sensible.
 */
export function mainModelSpec(preset: ModelPreset): string | undefined {
  return preset.config.tiers.big ?? preset.config.tiers.medium ?? preset.config.tiers.small;
}
