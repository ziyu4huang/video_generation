/**
 * Hotness decay (kcard-parity ticket 08) — bounded re-rank by the RecallLedger
 * usage feed.
 *
 * OpenViking's `hotness_score = sigmoid(log1p(active_count)) * exp(-λ·age)`
 * (half-life 7d, `openviking/retrieve/memory_lifecycle.py`) is ported as the
 * 0.0–1.0 frequency-recentcy signal, but the BLEND is deliberately NOT
 * OpenViking's linear `(1−α)·sem + α·h` — D8 requires bound ≤±10% ("re-ranks
 * but never dominates"), and the linear form is unbounded relative to the
 * semantic score scale. D37: the kcard blend is a RELATIVE-SCORE clamp —
 *
 *     final = score · (1 + β·(2h − 1)),   β = HOTNESS_BOUND_BETA = 0.1
 *
 * so every final score stays within [0.9·score, 1.1·score]: hotness can only
 * adjudicate ties/near-ties within a ±10% band, never dominate (a zero-score
 * card stays zero; h=0.5 is exactly neutral).
 *
 * Decay anchor (D39): max(md mtime, last usage access) — every card has an
 * mtime, so h is always computable; the usage feed supplies the access
 * signal once it exists. Half-life 7d (OpenViking parity; measured vault
 * mtimes cluster ~1d so today's discrimination comes from the usage feed).
 */

/** Half-life for the exponential recency decay, in days (OpenViking parity). */
export const HOTNESS_HALF_LIFE_DAYS = 7;
/** D37 bound: max relative perturbation of a score (≤±10%). */
export const HOTNESS_BOUND_BETA = 0.1;
/**
 * Neutral band — a hotness within ±ε of 0.5 is NOISE, not signal (a card
 * written milliseconds ago with zero accesses has h ≈ 0.5 by definition):
 * the fold is skipped (identity + unrecorded) so near-neutral folds cannot
 * shift pinned scores to the 11th digit. Below this band a recency/frequency
 * difference is too small to matter at β=0.1 regardless (factor within
 * ±0.02%).
 */
export const HOTNESS_NEUTRAL_EPSILON = 0.001;

export interface UsageAggregate {
	/** Append-only `usage` row count for the stem (the active_count). */
	count: number;
	/** Most recent usage `ts` (epoch ms); null = never accessed. */
	lastUseMs: number | null;
}

/** Stem → usage aggregate, read-computed at query time (D38 live GROUP BY). */
export type UsageStats = ReadonlyMap<string, UsageAggregate>;

/** Per-card hotness fold inputs (one per ranked entry). */
export interface HotnessEntry {
	/** md filename stem — the `usage` table key (D9 record key). */
	stem: string;
	/** The lane's final pre-hotness score. */
	score: number;
	/** md mtime (epoch ms) — the content recency half of the D39 anchor. */
	mtimeMs: number;
}

/** The 0.0–1.0 hotness score: sigmoid(log1p(active_count)) · exp-decay. */
export function hotnessScore(
	activeCount: number,
	lastUseMs: number | null,
	mtimeMs: number,
	nowMs = Date.now(),
	halfLifeDays = HOTNESS_HALF_LIFE_DAYS,
): number {
	const anchorMs = Math.max(mtimeMs, lastUseMs ?? 0);
	if (anchorMs <= 0) return 0;
	const ageDays = Math.max(nowMs - anchorMs, 0) / 86_400_000;
	const decayRate = Math.LN2 / halfLifeDays;
	const recency = Math.exp(-decayRate * ageDays);
	const freq = 1 / (1 + Math.exp(-Math.log1p(Math.max(activeCount, 0))));
	return freq * recency;
}

/** D37 clamp: score · (1 + β·(2h − 1)). h=0.5 → unchanged. */
export function clampWithHotness(score: number, h: number, beta = HOTNESS_BOUND_BETA): number {
	return score * (1 + beta * (2 * h - 1));
}

/** Hotness-augmented entry (result of rankWithHotness). */
export type RankedWithHotness<T extends HotnessEntry> = T & {
	/** The entry's position in the INPUT array (the sticky tie-break key and
	 *  the caller's map-back handle). Internal — strip before returning. */
	_idx: number;
	/** The 0.0–1.0 hotness score (for trace provenance). */
	hotness: number;
	/** The D37 multiplier applied to `score` (= 1 + β(2h−1)). */
	factor: number;
	/** The folded final score (= score · factor) — the new sort key. */
	finalScore: number;
};

/**
 * Fold the D37 clamp over ranked entries and re-sort — bounded re-rank.
 *
 * Determinism contract: entries are compared by finalScore desc, ties by the
 * PRE-FOLD INDEX (sticky — the fold never re-breaks an exact tie, so a fully
 * neutral fold (no usage, ~equal mtimes) is byte-order-identical, which keeps
 * the existing flat/hier test baselines stable). A tolerance epsilon guards
 * the exact-tie boundary: fixture cards written milliseconds apart fold with
 * ~1e-14 factor dust that must never flip an equal-score pair.
 *
 * A card with NO usage row still folds (count 0 → freq 0.5 · mtime recency —
 * the "recently-updated" half of D39), so `h` is defined for every card that
 * has an md file (bounded by β regardless).
 */
export function rankWithHotness<T extends HotnessEntry>(
	entries: readonly T[],
	stats: UsageStats,
	nowMs = Date.now(),
	beta = HOTNESS_BOUND_BETA,
): RankedWithHotness<T>[] {
	return entries
		.map((e, idx) => {
			const agg = stats.get(e.stem);
			const hotness = hotnessScore(agg?.count ?? 0, agg?.lastUseMs ?? null, e.mtimeMs, nowMs);
			// Neutral band: identity — the entry keeps its exact pre-fold score
			// (and is not flagged as folded) when hotness carries no signal.
			if (Math.abs(hotness - 0.5) <= HOTNESS_NEUTRAL_EPSILON) {
				return { ...e, _idx: idx, hotness, factor: 1, finalScore: e.score };
			}
			const factor = 1 + beta * (2 * hotness - 1);
			return { ...e, _idx: idx, hotness, factor, finalScore: e.score * factor };
		})
		.sort((a, b) => {
			const da = Math.abs(a.finalScore), db = Math.abs(b.finalScore);
			const tol = 1e-9 * Math.max(1, da, db);
			if (Math.abs(a.finalScore - b.finalScore) > tol) return b.finalScore - a.finalScore;
			return a._idx - b._idx;
		});
}
