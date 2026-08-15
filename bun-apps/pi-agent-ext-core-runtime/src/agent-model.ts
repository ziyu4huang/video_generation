/**
 * Model-spec resolution and tier fallback for a subagent run: which concrete
 * model an agent should use (explicit > tier > default-medium-tier), and what
 * to fall back to when a resolved spec turns out to be unavailable.
 *
 * Both functions are pure/injectable over model-tier-config.js only — neither
 * closes over CoreAgent or session state. That keeps this module a thin,
 * independently-testable layer between model-tier-config.ts and its callers:
 * anything needing only model/tier resolution can depend on this file without
 * pulling in CoreAgent's session-creation, budget, and turn-guard wiring that
 * the rest of agent.ts still carries. Today every consumer reaches these
 * through the barrel; the point is that the seam exists, not that it is
 * already used directly.
 */
import { loadModelTierConfig, type ModelTierConfig, resolveTierModel, sortedTierNames } from "./model-tier-config.js";

/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry (with a
 *      warning — see RCA#6: an unknown/misspelled tier must not silently
 *      escalate to the most expensive model).
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
export function resolveAgentModelSpec(
  options: { model?: string; tier?: string },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
): string | undefined {
  if (options.model) return options.model;
  const config = loadConfig();
  if (options.tier) {
    const resolved = config ? resolveTierModel(options.tier, config) : undefined;
    if (resolved) return resolved;
    // RCA#6: an unknown/misspelled tier (or no tier config at all) used to fall
    // back to mainModel SILENTLY — often the most expensive model, so a typo
    // quietly escalated cost. Surface it so the degradation is visible.
    console.warn(
      `[workflow] unknown tier "${options.tier}"${config ? "" : " (no model-tiers config found)"} — falling back to the session default${mainModel ? ` (${mainModel})` : ""}. Configured tiers: ${config ? sortedTierNames(config).join(", ") || "(none)" : "(none)"}. Manage them via /workflows-models (or /models-preset to apply a full config).`,
    );
    return mainModel;
  }
  // Untagged agent: default to the configured medium tier when one exists.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) return medium;
  }
  return undefined;
}

/**
 * Fallback decision when an explicitly-requested model spec turns out to be
 * UNavailable. The caller's `tier` (→ active /models-preset) degrades BEFORE
 * the session default, so subagents follow the preset by default instead of
 * silently landing on an arbitrary session default. (Previously an explicit
 * model short-circuited the tier, then the tier was discarded on fallback.)
 *
 * Pure + injectable (the async resolver + the tier config are passed in) so the
 * decision is unit-testable independent of the real ModelRegistry /
 * createAgentSession. Returns:
 *   - `{ kind: "tier", spec }` — a tier is set AND its preset model resolves in
 *     the registry; use `spec` as the fallback model.
 *   - `{ kind: "sessionDefault" }` — no tier, the tier isn't configured, or its
 *     model is also unavailable; use the session default.
 * `warning` is a loud one-line message naming requested → tier → actual (or →
 * session default) for the run log.
 */
export interface FallbackDecision {
  kind: "tier" | "sessionDefault";
  /** When `kind === "tier"`: the preset model spec to fall back to. */
  spec?: string;
  /** Loud one-line warning for the run log. */
  warning: string;
}

export async function resolveFallbackModel(
  requestedSpec: string,
  options: { tier?: string },
  config: ModelTierConfig | null,
  resolveModel: (spec: string) => Promise<unknown>,
): Promise<FallbackDecision> {
  if (options.tier && config) {
    const tierModelSpec = resolveTierModel(options.tier, config);
    if (tierModelSpec) {
      if (await resolveModel(tierModelSpec)) {
        return {
          kind: "tier",
          spec: tierModelSpec,
          warning: `[subagent] requested model "${requestedSpec}" unavailable; fell back to tier "${options.tier}" → "${tierModelSpec}" (active preset)`,
        };
      }
      return {
        kind: "sessionDefault",
        warning: `[subagent] requested model "${requestedSpec}" unavailable; tier "${options.tier}" → "${tierModelSpec}" also unavailable; using session default`,
      };
    }
    return {
      kind: "sessionDefault",
      warning: `[subagent] requested model "${requestedSpec}" unavailable; tier "${options.tier}" not configured in the active preset; using session default`,
    };
  }
  return {
    kind: "sessionDefault",
    warning: `[subagent] requested model "${requestedSpec}" unavailable; ${
      options.tier ? `tier "${options.tier}" has no model-tiers config to resolve; ` : "no tier given; "
    }using session default`,
  };
}
