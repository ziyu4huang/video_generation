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
 * Each preset pairs a text-LLM tier mapping with a vision lane. The vision
 * lane is no longer forced local (user request 2026-08-28): zai/glm-5.3-flash
 * and deepseek/deepseek-v4-flash-vision-exp are CLOUD vision models (both
 * vision-verified with real image calls — glm-5.3-flash 2026-08-28 via the
 * repo launcher's read tool on the FILE2MD E2E OCR fixture), so a preset can
 * now be fully cloud-provider. The local lm-studio bonsai lane remains the
 * built-in default seed's vision (s2-agent DEFAULT_MODEL_TIER_CONFIG), not a
 * preset. Switching text-LLM providers switches vision with them.
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

/** Shared vision capability block shape: one model across all vision tiers
 *  (vision / vision-large / vision-medium / vision-small). Users can re-point
 *  individual tiers later — resolveModelRole falls back to `vision` when a
 *  tiered key isn't set, so this four-key shape is the discoverable default.
 *  No `:off` suffix on the cloud lanes: their providers pin reasoning-effort
 *  off at the provider level (zai) or think always-on (deepseek), so there is
 *  no per-call no-think switch to pin here — unlike the local lm-studio lane,
 *  where the suffix maps to `reasoning_effort:"none"`. */
const glmVisionCaps = (spec: string) => ({
  vision: spec,
  "vision-large": spec,
  "vision-medium": spec,
  "vision-small": spec,
});

const ZAI_GLM_VISION_CAPS = glmVisionCaps("zai/glm-5.3-flash");
const DEEPSEEK_VISION_CAPS = glmVisionCaps("deepseek/deepseek-v4-flash-vision-exp");

export const MODEL_PRESETS: ModelPreset[] = [
  {
    // Renamed from "glm-lmstudio" 2026-08-28 when vision moved to the cloud
    // glm-5.3-flash lane — the "lmstudio" half of the old id named a vision
    // provider the preset no longer uses.
    id: "glm",
    label: "GLM (official) — GLM vision (cloud)",
    summary: "tiers: glm-5.3-flash / glm-5.3  ·  vision tiers: zai glm-5.3-flash (cloud)",
    config: {
      tiers: { small: "zai/glm-5.3-flash", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
      capabilities: { ...ZAI_GLM_VISION_CAPS },
    },
  },
  {
    id: "deepseek-pro",
    label: "DeepSeek pro (official) — DeepSeek vision (cloud)",
    summary: "tiers: bonsai-27b / flash / pro  ·  vision tiers: deepseek v4-flash-vision-exp (cloud)",
    config: {
      tiers: {
        small: "lm-studio/prism-ml/bonsai-27b",
        medium: "deepseek/deepseek-v4-flash",
        big: "deepseek/deepseek-v4-pro",
      },
      capabilities: { ...DEEPSEEK_VISION_CAPS },
    },
  },
  {
    id: "deepseek-flash",
    label: "DeepSeek flash (official) — DeepSeek vision (cloud)",
    summary: "tiers: bonsai-27b / bonsai-27b / flash  ·  vision tiers: deepseek v4-flash-vision-exp (cloud)",
    config: {
      tiers: {
        small: "lm-studio/prism-ml/bonsai-27b",
        medium: "lm-studio/prism-ml/bonsai-27b",
        big: "deepseek/deepseek-v4-flash",
      },
      capabilities: { ...DEEPSEEK_VISION_CAPS },
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
