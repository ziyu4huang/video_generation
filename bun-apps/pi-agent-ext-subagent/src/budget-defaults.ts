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

const ENV_KEYS = {
  disable: "SUBAGENT_TOKEN_BUDGET_DISABLE",
  small: "SUBAGENT_TOKEN_BUDGET_SMALL",
  medium: "SUBAGENT_TOKEN_BUDGET_MEDIUM",
  big: "SUBAGENT_TOKEN_BUDGET_BIG",
  multiplier: "SUBAGENT_TOKEN_BUDGET_MULTIPLIER",
} as const;

/** "1" or "true" (case-insensitive) → true; anything else (incl. unset) → false. */
function envFlagTrue(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw?.toLowerCase() === "true";
}

/** Parse a positive integer string; invalid/non-positive/unset → undefined. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parse a positive finite float string; invalid/non-positive/unset → undefined. */
function parsePositiveFloat(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function tierEnvKey(tier: "small" | "medium" | "big"): string {
  return tier === "small" ? ENV_KEYS.small : tier === "medium" ? ENV_KEYS.medium : ENV_KEYS.big;
}

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
 * 1. `SUBAGENT_TOKEN_BUDGET_DISABLE`="1"/"true" → `undefined` (no budget at all);
 * 2. explicit `tier` set → `TIERED_TOKEN_BUDGET_DEFAULTS[tier]` (unknown tier → medium);
 * 3. else reverse-map `model` → tier via `config` (default `loadModelTierConfig()`);
 * 4. else the safe `medium` ceiling;
 * 5. `SUBAGENT_TOKEN_BUDGET_<TIER>` (resolved tier) may replace the ceiling;
 * 6. `SUBAGENT_TOKEN_BUDGET_MULTIPLIER` scales the result;
 * 7. clamp to `Math.max(1, Math.floor(result))`.
 *
 * Env vars are read AT CALL TIME (no caching). Invalid/unparseable values are
 * silently ignored (the previous step's value falls through).
 *
 * `config` is an optional param so tests can inject a fixture without touching disk;
 * production omits it and reads the user's `~/.pi/workflows/model-tiers.json`.
 */
export function tierDefaultToken(
  tier: string | undefined,
  model?: string,
  config: ModelTierConfig | null = loadModelTierConfig(),
): number | undefined {
  // 0. hard disable → no budget (unbounded run).
  if (envFlagTrue(ENV_KEYS.disable)) return undefined;
  const TABLE = TIERED_TOKEN_BUDGET_DEFAULTS;
  // 1-3. resolve the tier, then take that tier's ceiling.
  let resolved: keyof typeof TABLE;
  if (tier && tier in TABLE) resolved = tier as keyof typeof TABLE;
  else {
    const mapped = tierForModel(model, config);
    resolved = mapped && mapped in TABLE ? (mapped as keyof typeof TABLE) : SAFE_FALLBACK_TIER;
  }
  // 4. absolute per-tier override (applies to the RESOLVED tier).
  let result = parsePositiveInt(process.env[tierEnvKey(resolved)]) ?? TABLE[resolved];
  // 5. multiplier (applied after any absolute override).
  const multiplier = parsePositiveFloat(process.env[ENV_KEYS.multiplier]);
  if (multiplier !== undefined) result *= multiplier;
  // 6. clamp.
  return Math.max(1, Math.floor(result));
}
