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
 * Clamp a requested model spec (`provider/id`) to the session's scoped models
 * (ctx.scopedModels, fed by CLI --models / enabledModels).
 *
 * Behavior lock (ticket 11):
 * - empty scope → the request stands unchanged (full-catalog behavior);
 * - exact match → the request stands unchanged;
 * - out of scope → warn-and-clamp to the FIRST scoped model (never a hard error).
 * Pure: no I/O, no logging — callers own the warning surface.
 */
export function clampModelToScope(
  requestedSpec: string,
  scopedSpecs: readonly string[],
): { spec: string; clamped: boolean } {
  // Destructure rather than test `.length === 0`: it states the same "empty
  // scope" condition AND gives the compiler the narrowing it needs for the
  // clamp return. `scopedSpecs[0]` is `string | undefined` under
  // noUncheckedIndexedAccess, which the length check does not refute.
  const [fallback] = scopedSpecs;
  if (fallback === undefined) return { spec: requestedSpec, clamped: false };
  if (scopedSpecs.includes(requestedSpec)) return { spec: requestedSpec, clamped: false };
  return { spec: fallback, clamped: true };
}
