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
import type { ModelTierConfig } from "./model-tier-config.js";
import { getEffectiveModelTierConfig } from "./model-tier-config.js";

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
  maxTurns: "SUBAGENT_MAX_TURNS",
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
 * production omits it and reads the effective config (transient session preset
 * override ?? the user's `~/.pi/workflows/model-tiers.json`).
 */
export function tierDefaultToken(
  tier: string | undefined,
  model?: string,
  config: ModelTierConfig | null = getEffectiveModelTierConfig(),
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

/**
 * #03 role-aware dispatch bounds (2026-08-15 hardening). A dispatch that omits
 * ALL of tokenBudget/maxTurns/timeoutMs used to run with only the tier token
 * ceiling + the 15-min timeout and NO turn cap — unbounded recon dispatches
 * burned 400-500k tokens returning zero output. These bounds give the two
 * dispatch archetypes a complete default envelope instead:
 *
 * | role   | tokenBudget | maxTurns | timeoutMs | rationale                           |
 * |--------|-------------|----------|-----------|-------------------------------------|
 * | recon  | 120k (≤     | 12       | 5 min     | 2026-08-18 rebalance (200-run       |
 * |        | tier        |          |           | ledger): done-median 71k sat ABOVE  |
 * |        | ceiling)    |          |           | the old 60k ceiling; turns is the   |
 * |        |             |          |           | top killer (31/200) and 8 turns     |
 * |        |             |          |           | starved read-heavy recon (~10k      |
 * |        |             |          |           | fixed overhead per turn); min() vs  |
 * |        |             |          |           | tier ceiling still intact.          |
 * | writer | 400k        | 28       | 20 min    | turns-abort median ≈28 — writers    |
 * |        |             |          |           | died one step from finishing at 24. |
 *
 * Applied ONLY when all three are omitted AT THE PARAMS level (timeoutMs is
 * always defaulted downstream in buildSpawnOptions/mergeReadOnlyExclusion, so
 * "omitted" must be detected before those defaults land). An explicit bound of
 * any kind opts the WHOLE envelope out — partial overrides are never mixed in.
 */
export const ROLE_AWARE_DISPATCH_BOUNDS = {
  recon: { tokenBudget: 120_000, maxTurns: 12, timeoutMs: 5 * 60_000 },
  writer: { tokenBudget: 400_000, maxTurns: 28, timeoutMs: 20 * 60_000 },
} as const;

export type DispatchRole = keyof typeof ROLE_AWARE_DISPATCH_BOUNDS;

export interface RoleAwareDefaults {
  applied: boolean;
  tokenBudget?: number;
  maxTurns?: number;
  timeoutMs?: number;
  notice?: string;
}

/**
 * Pure resolver for the role-aware dispatch envelope. `applied` is true ONLY
 * when (a) SUBAGENT_TOKEN_BUDGET_DISABLE is unset (same escape hatch as the
 * tier ceilings; env read at call time) and (b) all three bounds are omitted
 * in `p`. `tierCeiling` (the tierDefaultToken value for the dispatch's model)
 * caps the recon tokenBudget so a recon default never exceeds the
 * p90-calibrated tier policy.
 *
 * `opts.persistent` (cc-parity-2 ticket 05, F2): the dispatch opens a NAMED
 * live agent, whose tokenBudget/maxTurns/timeoutMs are AGENT-LIFETIME
 * ceilings checked against cumulative stats after every exchange — the
 * per-dispatch role envelope is not a lifetime calibration (the recon 120k
 * tripped at 164k on two trivial big-context exchanges: each exchange re-bills
 * the whole fixed context). The lifetime token default becomes the tier
 * ceiling instead (500k/1.2M/1.5M, itself p90-calibrated per dispatch and so
 * comfortably loose as a lifetime bound), and no default maxTurns/timeoutMs is
 * applied — a live agent lives until disposed. Explicit params still opt out
 * entirely (checked above), and `SUBAGENT_TOKEN_BUDGET_DISABLE` still escapes.
 */
export function roleAwareDefaults(
  p: { tokenBudget?: number; maxTurns?: number; timeoutMs?: number },
  role: DispatchRole,
  tierCeiling?: number,
  opts: { persistent?: boolean } = {},
): RoleAwareDefaults {
  if (envFlagTrue(ENV_KEYS.disable)) return { applied: false };
  if (p.tokenBudget !== undefined || p.maxTurns !== undefined || p.timeoutMs !== undefined) {
    return { applied: false };
  }
  if (opts.persistent) {
    return {
      applied: true,
      tokenBudget: tierCeiling,
      notice:
        "bounds: live-agent lifetime default applied (tier ceiling; no default turn/timeout cap) — pass tokenBudget/maxTurns/timeoutMs to override",
    };
  }
  const bounds = ROLE_AWARE_DISPATCH_BOUNDS[role];
  // #02 SUBAGENT_MAX_TURNS: global turn-cap valve over the role envelope —
  // replaces the role's maxTurns when set (positive integer), mirroring how
  // SUBAGENT_TOKEN_BUDGET_<TIER> replaces a tier ceiling. Explicit params
  // still opt the whole envelope out (checked above).
  const envMaxTurns = parsePositiveInt(process.env[ENV_KEYS.maxTurns]);
  return {
    applied: true,
    tokenBudget:
      role === "recon" && tierCeiling !== undefined ? Math.min(bounds.tokenBudget, tierCeiling) : bounds.tokenBudget,
    maxTurns: envMaxTurns ?? bounds.maxTurns,
    timeoutMs: bounds.timeoutMs,
    notice: `bounds: defaults applied (${role}) — pass tokenBudget/maxTurns/timeoutMs to override`,
  };
}
