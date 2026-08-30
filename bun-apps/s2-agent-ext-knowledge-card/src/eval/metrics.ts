/**
 * src/eval/metrics.ts — retrieval-eval metric math (context-lifecycle ticket 15,
 * D10 consolidation).
 *
 * Pure module — no IO, no ExtensionAPI. Everything the `scripts/retrieval-eval.mjs`
 * harness reports as a NUMBER lives here so the package suite can pin the math
 * on hand-computable fixtures (`__tests__/retrieval-eval.test.ts`), independent
 * of any live corpus or embedder (the ≤5-min local_ci rule keeps the harness
 * itself opt-in via `bun run test:eval`; only this module is CI-pinned).
 *
 * Metric definitions (matching recall-audit.mjs, the t04-committed harness this
 * consolidates around — do not drift them apart silently):
 *   - hit@k: graded queries whose target ranks within the top k (rank ≥ 1
 *     counts as a hit at 1; 0 = miss);
 *   - MRR: mean of 1/rank over graded queries (miss contributes 0);
 *   - tokens-per-render: estimated tokens of the tier-rendered `detail` text a
 *     consumer would actually pay for — chars/4 (the plain-English heuristic;
 *     the tier-ladder budgets were measured under the same estimate).
 */

/** Rank of the first entry in `ranked` satisfying `match` (1-based, 0 = miss). */
export function firstHitRank<T>(ranked: readonly T[], match: (entry: T) => boolean): number {
	for (let i = 0; i < ranked.length; i++) if (match(ranked[i]!)) return i + 1;
	return 0;
}

/** Rough token estimate for rendered card text — chars/4, ceil. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export interface PerQueryOutcome {
	/** 1-based rank of the target; 0 = miss. */
	rank: number;
	/** Estimated tokens of the rendered set actually returned for this query. */
	tokensRendered: number;
	/** Cards returned for this query (the per-card token mean's denominator). */
	cardsReturned: number;
	/** True when the query's target is absent from the corpus (scored separately,
	 *  never as a retrieval miss — the t04 corpus-coverage discipline). */
	targetAbsent?: boolean;
}

export interface RetrievalMetrics {
	graded: number;
	hit1: number;
	hit3: number;
	hitK: number;
	k: number;
	mrr: number;
	/** Misses at k (graded − hitK). */
	misses: number;
	/** Mean rendered tokens per graded query. */
	tokensPerQuery: number;
	/** Mean rendered tokens per returned card across graded queries. */
	tokensPerCard: number;
	/** Queries whose target was absent (excluded from every rate above). */
	absent: number;
}

/** Aggregate hit@k / MRR / token costs over per-query outcomes.
 *  `targetAbsent` outcomes are counted in `absent` and otherwise ignored. */
export function computeMetrics(outcomes: readonly PerQueryOutcome[], k: number): RetrievalMetrics {
	const kept = outcomes.filter((o) => !o.targetAbsent);
	let hit1 = 0;
	let hit3 = 0;
	let hitK = 0;
	let mrrSum = 0;
	let tokenSum = 0;
	let cardSum = 0;
	for (const o of kept) {
		if (o.rank === 1) hit1++;
		if (o.rank >= 1 && o.rank <= 3) hit3++;
		if (o.rank >= 1 && o.rank <= k) hitK++;
		if (o.rank >= 1) mrrSum += 1 / o.rank;
		tokenSum += o.tokensRendered;
		cardSum += o.cardsReturned ?? 0;
	}
	const n = kept.length || 1; // guard: no graded queries → zeroed rates, not NaN
	return {
		graded: kept.length,
		hit1,
		hit3,
		hitK,
		k,
		mrr: Number((mrrSum / n).toFixed(3)),
		misses: kept.length - hitK,
		tokensPerQuery: Number((tokenSum / n).toFixed(1)),
		tokensPerCard: Number((tokenSum / Math.max(1, cardSum)).toFixed(1)),
		absent: outcomes.length - kept.length,
	};
}
