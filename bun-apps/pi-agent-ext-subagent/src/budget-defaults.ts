/**
 * #01 default token-budget guardrails — tier-calibrated HARD-ABORT ceilings.
 *
 * Motivation: budgets WORK when set (run msl3c9zi aborted cleanly at 380k), but
 * they are RARELY set — 80%+ of dispatches omit tokenBudget, so unbounded runs
 * blow past sane limits (1.34M for a 17-line fix; 3.4M/6.3M runaway tail). This
 * module supplies a TIER-CALIBRATED DEFAULT so every dispatch has a ceiling.
 *
 * The hard-abort path itself already ships: `classifyError` maps
 * `TOKEN_BUDGET_EXHAUSTED` → non-transient (no retry), surfaced as
 * `result.budget` + `status:"budget"`. We only supply the DEFAULT value.
 *
 * Calibration (200 retained `status:done` runs; `usage.total` per tier):
 *
 * | tier  | p90 usage.total | chosen ceiling | rationale                                 |
 * |-------|-----------------|----------------|-------------------------------------------|
 * | small | 461k            | 500k           | ceil just above p90; catches the 927k     |
 * |       |                 |                | "write 2 memory entries" runaway.         |
 * | medium| 1.1M            | 1.2M           | catches the 1.34M "17-line fix" runaway.  |
 * | big   | 1.4M            | 1.5M           | the 3.4M / 6.3M runaway tail is aborted.  |
 *
 * Ceilings sit just above the p90 so only the runaway tail is hard-aborted. A
 * flat 40k/120k/250k default (PRD's first guess) was rejected — it would
 * false-abort ≥50% of medium runs (median medium run ≈ 600k > 120k).
 *
 * spendBudget is intentionally NOT defaulted: on this MLX stack every model is
 * local (cost≡0 in every retained run), so a spend ceiling can never fire.
 */
import type { ModelTierConfig } from "@repo/pi-agent-ext-core-runtime";
import { loadModelTierConfig } from "@repo/pi-agent-ext-core-runtime";

/**
 * p90-calibrated per-tier token ceilings (hard-abort). See module doc + the
 * Calibration table above.
 */
export const TIERED_TOKEN_BUDGET_DEFAULTS: Record<"small" | "medium" | "big", number> = {
  small: 500_000,
  medium: 1_200_000,
  big: 1_500_000,
};

const SAFE_FALLBACK_TIER: keyof typeof TIERED_TOKEN_BUDGET_DEFAULTS = "medium";

/** Strip a `:thinking` (or similar) role suffix from a model spec for matching. */
function baseSpec(spec: string): string {
  return spec.split(":")[0] ?? spec;
}

/**
 * Resolve a model spec back to its tier name by inverting `config.tiers`
 * (tier→spec). Returns `undefined` when the model is not configured under any tier.
 */
function tierForModel(model: string | undefined, config: ModelTierConfig | null): string | undefined {
  if (!model || !config) return undefined;
  const want = baseSpec(model);
  for (const [tier, spec] of Object.entries(config.tiers)) {
    if (baseSpec(spec) === want) return tier;
  }
  return undefined;
}

/**
 * The default token ceiling for a dispatch:
 * 1. explicit `tier` set → `TIERED_TOKEN_BUDGET_DEFAULTS[tier]` (unknown tier → medium);
 * 2. else reverse-map `model` → tier via `config` (default `loadModelTierConfig()`);
 * 3. else the safe `medium` ceiling.
 *
 * `config` is an optional param so tests can inject a fixture without touching disk;
 * production omits it and reads the user's `~/.pi/workflows/model-tiers.json`.
 */
export function tierDefaultToken(
  tier: string | undefined,
  model?: string,
  config: ModelTierConfig | null = loadModelTierConfig(),
): number {
  const TABLE = TIERED_TOKEN_BUDGET_DEFAULTS;
  // 1. explicit known tier → that tier's ceiling.
  if (tier && tier in TABLE) return TABLE[tier as keyof typeof TABLE];
  // 2. reverse-map the model→tier via config; only a KNOWN tier name maps.
  const mapped = tierForModel(model, config);
  if (mapped && mapped in TABLE) return TABLE[mapped as keyof typeof TABLE];
  // 3. safe middle ceiling.
  return TABLE[SAFE_FALLBACK_TIER];
}
