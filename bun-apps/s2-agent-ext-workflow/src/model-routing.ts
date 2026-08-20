/**
 * Per-stage model routing for workflows.
 * Allows different phases to use different models.
 */

export interface ModelRoute {
  /** Phase name pattern (regex or exact match). */
  phasePattern: string;
  /** Model to use for this phase. */
  model: string;
  /** Whether to use regex matching. */
  useRegex?: boolean;
}

export interface ModelRoutingConfig {
  /** Default model for all phases. */
  defaultModel?: string;
  /** Per-phase model overrides. */
  routes: ModelRoute[];
}

/**
 * Resolve which model to use for a given phase.
 */
export function resolveModelForPhase(phase: string | undefined, config: ModelRoutingConfig): string | undefined {
  if (!phase || !config.routes.length) {
    return config.defaultModel;
  }

  for (const route of config.routes) {
    if (route.useRegex) {
      try {
        const regex = new RegExp(route.phasePattern, "i");
        if (regex.test(phase)) {
          return route.model;
        }
      } catch {
        // Invalid regex, skip
      }
    } else if (phase === route.phasePattern) {
      // Exact, case-sensitive match — phase titles are author-controlled literals,
      // so fuzzy substring matching only caused mis-routes (e.g. "analyze" matching
      // "analyze-deep" or vice-versa). Use the regex branch for fuzzy needs.
      return route.model;
    }
  }

  return config.defaultModel;
}

/**
 * Parse model routing from workflow meta: per-phase models from meta.phases[].model
 * and a top-level default from meta.model (used when no phase route matches).
 */
export function parseModelRoutingFromMeta(
  phases?: Array<{ title: string; model?: string }>,
  defaultModel?: string,
): ModelRoutingConfig {
  const routes: ModelRoute[] = [];

  if (phases) {
    for (const phase of phases) {
      if (phase.model) {
        routes.push({
          phasePattern: phase.title,
          model: phase.model,
        });
      }
    }
  }

  return { defaultModel, routes };
}

/**
 * The scope clamp now lives in `@repo/s2-agent-core-runtime` (agent-model.ts),
 * next to `resolveAgentModelSpec`.
 *
 * It used to live here and was applied in workflow-runtime to `opts.model`,
 * which is the ONE dispatch path this layer can see a concrete spec for. The
 * tier path deliberately leaves `modelSpec` undefined here so the tier resolves
 * downstream, and the untagged default-to-medium path never produces a spec at
 * this layer at all — so both escaped the clamp entirely while the picker and
 * the runtime both looked scoped. Moving the rule below the resolution point
 * means every branch of the precedence chain passes through it exactly once.
 *
 * Re-exported so existing importers of this module keep working.
 */
export { clampModelToScope } from "@repo/s2-agent-core-runtime";
