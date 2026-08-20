/**
 * Per-entry heat scoring core — UPSP §1 "per-entry decay" (ticket #1b).
 *
 * Pure, no I/O, DB-free. Heat is computed **lazily at eviction time** from
 * existing columns (recency + mw_success/mw_fail + the #06 `used_at` boolean)
 * — never persisted, never periodic. Other tasks wire it into the eviction
 * floors + consolidator snapshot via a provider callback that crosses the
 * MemoryStore's DB-free boundary.
 *
 * Model (D2):
 * ```
 * heat ∈ [0,1], higher = hotter = spared
 * recencySpine = exp(-ageDays / halflifeDays)        // age from lastReferenced
 * worthMult    = 1 + worthWeight * (laplace - 0.5)    // laplace = (mw_success+1)/(mw_success+mw_fail+2)
 * usedBonus    = usedExists ? usedBonusAmount : 0
 * heat         = clamp(recencySpine * worthMult + usedBonus, 0, 1)
 * ```
 * `decayEnabled === false` (handled by the caller) simply skips wiring the
 * provider → eviction reverts to FIFO (the disable path is a first-class
 * invariant; this module is only consulted when decay is on).
 */

import {
  MS_PER_DAY,
  DEFAULT_DECAY_HALFLIFE_DAYS,
  DEFAULT_DECAY_WORTH_WEIGHT,
  DEFAULT_DECAY_USED_BONUS,
} from "../constants.js";

/** Inputs to `computeHeat`. Dates are flexible strings (ISO or date-only). */
export interface HeatInput {
  /** Most-recent reference date (ISO or "YYYY-MM-DD"). Falls back to `created`,
   *  then epoch. Invalid → epoch (heat → 0). */
  lastReferenced?: string;
  /** Creation date (ISO or "YYYY-MM-DD"). Used when `lastReferenced` is absent. */
  created?: string;
  /** Memory-worth success count (recall confirmed). Laplace numerator-1. */
  mwSuccess: number;
  /** Memory-worth fail count (recall missed / corrected). Laplace denominator. */
  mwFail: number;
  /** True if any `session_assembly` row for this entry has `used_at` (#06). */
  usedExists: boolean;
  /** Wall-clock reference for age computation (injected for determinism). */
  now: Date;
}

/** Resolved decay knobs — normalized from a raw MemoryConfig subset. */
export interface DecayConfig {
  /** Recency-exp halflife in days. */
  halflifeDays: number;
  /** Worth multiplier weight (0..1). */
  worthWeight: number;
  /** Heat bonus for ever-used entries. */
  usedBonus: number;
}

/**
 * Resolve decay config knobs from a raw config subset, filling the
 * `DEFAULT_DECAY_*` defaults for absent fields. Pure; shared by the scoring
 * core and the index.ts provider wiring (T3).
 */
export function resolveDecayConfig(config: {
  decayHalflifeDays?: number;
  decayWorthWeight?: number;
  decayUsedBonus?: number;
}): DecayConfig {
  return {
    halflifeDays: config.decayHalflifeDays ?? DEFAULT_DECAY_HALFLIFE_DAYS,
    worthWeight: config.decayWorthWeight ?? DEFAULT_DECAY_WORTH_WEIGHT,
    usedBonus: config.decayUsedBonus ?? DEFAULT_DECAY_USED_BONUS,
  };
}

/**
 * Parse a flexible date string (full ISO 8601 or date-only "YYYY-MM-DD") into a
 * `Date`. Tolerant: an empty/invalid value falls back to **epoch** (timestamp
 * 0), which yields a huge age → `recencySpine → 0` → `heat → 0` (a stale /
 * undated entry is treated as maximally cold, never maximally hot). This is
 * the safe direction — an undateable date must never inflate heat.
 *
 * Note: this fallback applies to a SINGLE resolved string. The higher-level
 * date fallback chain (lastReferenced → created → epoch-literal) lives in
 * `computeHeat` via the `??` operator: `lastReferenced ?? created ?? "1970-01-01"`.
 * So an invalid-but-present `lastReferenced` does NOT fall through to `created`
 * — it resolves to epoch (heat 0). This matches the spec's `??` chain.
 */
function parseDate(value: string | undefined): Date {
  if (!value) return new Date(0); // epoch
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date(0); // invalid → epoch (heat → 0)
  return d;
}

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Compute the per-entry heat score ∈ [0, 1] (higher = hotter = spared from
 * eviction). Pure + deterministic given a fixed `now`.
 *
 * Date fallback: `lastReferenced ?? created ?? "1970-01-01"` (epoch), then
 * `parseDate` maps any invalid/empty value in that slot to epoch → age huge →
 * heat → 0.
 */
export function computeHeat(input: HeatInput, cfg: DecayConfig): number {
  // ageDays ≥ 0 (a future-dated entry clamps to age 0, i.e. maximally fresh).
  const anchor = input.lastReferenced ?? input.created ?? "1970-01-01";
  const ageDays = Math.max(0, (input.now.getTime() - parseDate(anchor).getTime()) / MS_PER_DAY);

  const recencySpine = Math.exp(-ageDays / cfg.halflifeDays);

  // Laplace-smoothed recall success rate; neutral 0.5 at zero evidence.
  const laplace = (input.mwSuccess + 1) / (input.mwSuccess + input.mwFail + 2);

  // Worth multiplier: ± around 1.0 based on recall success vs neutral 0.5.
  const worthMult = 1 + cfg.worthWeight * (laplace - 0.5);

  const usedBonus = input.usedExists ? cfg.usedBonus : 0;

  return clamp(recencySpine * worthMult + usedBonus, 0, 1);
}
