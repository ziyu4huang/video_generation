/**
 * Model-spec resolution, session-scope clamping, and tier fallback for a
 * subagent run: which concrete model an agent should use (explicit > tier >
 * default-medium-tier), whether that model is inside the session's allowed
 * scope, and what to fall back to when a resolved spec turns out to be
 * unavailable.
 *
 * All functions are pure/injectable over model-tier-config.js only — none
 * closes over CoreAgent or session state. That keeps this module a thin,
 * independently-testable layer between model-tier-config.ts and its callers:
 * anything needing only model/tier resolution can depend on this file without
 * pulling in CoreAgent's session-creation, budget, and turn-guard wiring that
 * the rest of agent.ts still carries. Today every consumer outside this
 * package reaches these through the barrel; the point is that the seam
 * exists, not that it is already used directly.
 */

import { logModelDecision } from "./debug-models.js";
import {
  getEffectiveModelTierConfig,
  type ModelTierConfig,
  resolveTierModel,
  sortedTierNames,
} from "./model-tier-config.js";

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
  loadConfig: () => ModelTierConfig | null = getEffectiveModelTierConfig,
): string | undefined {
  if (options.model) {
    logModelDecision("resolve", { branch: "explicit-model", spec: options.model });
    return options.model;
  }
  const config = loadConfig();
  if (options.tier) {
    const resolved = config ? resolveTierModel(options.tier, config) : undefined;
    if (resolved) {
      logModelDecision("resolve", { branch: "tier", tier: options.tier, spec: resolved });
      return resolved;
    }
    // RCA#6: an unknown/misspelled tier (or no tier config at all) used to fall
    // back to mainModel SILENTLY — often the most expensive model, so a typo
    // quietly escalated cost. Surface it so the degradation is visible.
    console.warn(
      `[workflow] unknown tier "${options.tier}"${config ? "" : " (no model-tiers config found)"} — falling back to the session default${mainModel ? ` (${mainModel})` : ""}. Configured tiers: ${config ? sortedTierNames(config).join(", ") || "(none)" : "(none)"}. Manage them via /workflows-models (or /models-preset to apply a full config).`,
    );
    logModelDecision("resolve", { branch: "unknown-tier-fallback", tier: options.tier, spec: mainModel });
    return mainModel;
  }
  // Untagged agent: default to the configured medium tier when one exists.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) {
      logModelDecision("resolve", { branch: "default-medium", spec: medium });
      return medium;
    }
  }
  logModelDecision("resolve", { branch: "session-default", spec: mainModel });
  return undefined;
}

/**
 * Clamp a resolved model spec (`provider/id`) to the session's scoped models
 * (`ctx.scopedModels`, fed by CLI `--models` / `enabledModels`).
 *
 * Contract:
 * - empty/undefined scope → the request stands unchanged (full-catalog);
 * - spec already in scope → unchanged;
 * - out of scope → warn-and-clamp, never a hard error.
 *
 * WHERE IT LIVES, AND WHY HERE
 *   This started life in s2-agent-ext-workflow, applied to `opts.model` inside
 *   workflow-runtime. That covered ONE dispatch path. `opts.tier` sets
 *   `modelSpec` to undefined at that layer on purpose (the tier resolves later),
 *   so the tier path — the path `modelRoutingGuideline` actively steers authors
 *   toward with "TAG EVERY agent with opts.tier" — went out of scope unclamped,
 *   as did the untagged default-to-medium path. Both resolve through
 *   {@link resolveAgentModelSpec}, so the clamp belongs next to it: one rule,
 *   applied once, downstream of every precedence branch.
 *
 * FALLBACK CHOICE
 *   Prefer `mainModel` when it is itself in scope: it is the user's actual
 *   session model, so a clamped `big`-tier agent lands on something deliberate.
 *   The previous rule — always the FIRST scoped spec — meant an expensive
 *   synthesis agent silently ran on whatever `--models` happened to list first.
 *   `scopedSpecs[0]` remains the fallback-of-the-fallback for when there is no
 *   main model or it is out of scope, which preserves the old behavior exactly
 *   in those cases.
 *
 * Pure: no I/O, no logging — callers own the warning surface.
 */
export function clampModelToScope(
  requestedSpec: string,
  scopedSpecs: readonly string[] | undefined,
  mainModel?: string,
): { spec: string; clamped: boolean } {
  // Destructure rather than test `.length === 0`: it states the same "empty
  // scope" condition AND gives the compiler the narrowing it needs for the
  // clamp return. `scopedSpecs[0]` is `string | undefined` under
  // noUncheckedIndexedAccess, which the length check does not refute.
  const [first] = scopedSpecs ?? [];
  if (first === undefined) return { spec: requestedSpec, clamped: false };
  if (scopedSpecs?.includes(requestedSpec)) return { spec: requestedSpec, clamped: false };
  const fallback = mainModel !== undefined && scopedSpecs?.includes(mainModel) ? mainModel : first;
  return { spec: fallback, clamped: true };
}

/**
 * Resolve + clamp in one step: the exact composition `CoreAgent.run` performs.
 *
 * It exists as a named function rather than two calls at the call site so the
 * guard test can enumerate EVERY precedence path — explicit model, agentType /
 * phase model (both folded into `options.model` upstream), tier, unknown tier,
 * and the untagged default-to-medium — against the real composition. Testing
 * `resolveAgentModelSpec` and `clampModelToScope` separately proves each is
 * right and proves nothing about whether the second is reached from every
 * branch of the first, which is precisely the defect this closes.
 *
 * `spec` is undefined only when resolution yields nothing (session default
 * applies); the session's own model is already inside its scope, so there is
 * nothing to clamp in that case.
 */
export function resolveScopedAgentModelSpec(
  options: { model?: string; tier?: string },
  mainModel: string | undefined,
  scopedSpecs: readonly string[] | undefined,
  loadConfig: () => ModelTierConfig | null = getEffectiveModelTierConfig,
): { spec: string | undefined; clamped: boolean; requested?: string } {
  const resolved = resolveAgentModelSpec(options, mainModel, loadConfig);
  if (resolved === undefined) return { spec: undefined, clamped: false };
  const { spec, clamped } = clampModelToScope(resolved, scopedSpecs, mainModel);
  if (clamped) logModelDecision("clamp", { requested: resolved, spec, reason: "out of session scope" });
  return clamped ? { spec, clamped, requested: resolved } : { spec, clamped };
}

/**
 * Fallback decision when an explicitly-requested model spec turns out to be
 * UNavailable. The caller's `tier` (→ active session preset) degrades BEFORE
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
