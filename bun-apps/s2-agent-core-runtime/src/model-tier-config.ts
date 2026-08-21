/**
 * Model tier configuration — re-exports the leaf resolver (model-role-config.ts)
 * for back-compat, and keeps buildDefaultTierConfig (which needs
 * available-models.ts's listAvailableModelSpecs). Lightweight consumers import
 * model-role-config.ts directly to avoid pulling available-models.ts.
 *
 * A tier is a named slot (small/medium/big) holding exactly ONE model spec
 * string (e.g. "openai/gpt-4.1-mini"). When an agent() call specifies opts.tier,
 * that single model is resolved and used as the subagent's model (unless an
 * explicit opts.model is given, which always wins — see agent-model.ts).
 */

import { listAvailableModelSpecs } from "./available-models.js";
import type { ModelTierConfig } from "./model-role-config.js";

export type { ModelTierConfig } from "./model-role-config.js";
export {
  getEffectiveModelTierConfig,
  getModelTierConfigPath,
  getTransientModelTierConfig,
  loadModelTierConfig,
  resolveModelRole,
  resolveTierModel,
  saveModelTierConfig,
  setTransientModelTierConfig,
  sortedTierNames,
} from "./model-role-config.js";

/**
 * Build a default tier config where every tier points at a single model —
 * the user's currently active Pi model when known, else the first available
 * model. New users get consistent behaviour (every tier == the model they're
 * already chatting with) and can refine tiers later via `/workflows-models`.
 */
export async function buildDefaultTierConfig(currentModelSpec?: string): Promise<ModelTierConfig> {
  const model = currentModelSpec ?? (await listAvailableModelSpecs())[0] ?? "";
  return {
    tiers: {
      small: model,
      medium: model,
      big: model,
    },
  };
}
