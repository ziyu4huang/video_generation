/**
 * src/feedback/hotness-feed.ts — the t11 USED-ledger feed for hotness
 * (context-lifecycle ticket 12, D8).
 *
 * DISTINCT from src/usage.ts's SurrealDB access ledger (the t08
 * `hotnessAlpha` feed, D37 — what was SERVED): this module replays
 * `<vault>/.knowledge-usage.jsonl` (ticket 11 — what was USED, three
 * provenance sources) into the SAME `UsageAggregate` shape, so
 * `hotnessScore` (src/hotness.ts) consumes either ledger unchanged.
 *
 * Blend shape (ticket 12, reconciled against its own acceptance criteria):
 * the ticket's prose says "score × (0.9 + 0.2·hotness)" — the D8 envelope
 * [0.9, 1.1]. Its ACCEPTANCE pins two properties that literal map cannot
 * give: stale usage "decays to neutral (multiplier → 1.0 as age → ∞)" and
 * "never-used cards unaffected" (byte-identical, the regression pin). Both
 * force the neutral point at h=0, so the implemented multiplier is
 *
 *     m(h) = 1 + HOTNESS_ALPHA_MAX · h   ∈ [1.0, 1.1]  ⊆ [0.9, 1.1]
 *
 * i.e. the D8 envelope's upper half only: usage can only REWARD (used and
 * recent ranks up), never punish, and both never-used and fully-stale cards
 * keep score 1.0 — byte-identical ranking among cards no ledger row covers.
 *
 * Pure module — no IO, no Date.now() (the caller injects `now`); the ledger
 * READ lives one call up (retrieveRecords reads once per call, "memoized per
 * retrieve call", and threads the aggregate map down every lane).
 */
import { HOTNESS_ALPHA_MAX, hotnessScore } from "../hotness.ts";
import type { UsageAggregate } from "../usage.ts";
import type { UsageRow } from "./usage.ts";

/** Replay used-ledger rows into per-uri aggregates — the exact output shape
 *  of `usageAggregates` (src/usage.ts), keyed by the ledger row's `uri` (the
 *  card's canonical record id; callers fall back to the filename stem for
 *  cards that predate source_id). One row = one use; `lastUsedAtMs` = max
 *  Date.parse(at) across the uri's rows. Rows with an unparseable `at` still
 *  count toward activeCount but never win the max (hotnessScore then ages
 *  from an older event — conservative). Pure: same rows in, same map out. */
export function usedLedgerAggregates(rows: readonly UsageRow[]): Map<string, UsageAggregate> {
	const out = new Map<string, UsageAggregate>();
	for (const r of rows) {
		const cur = out.get(r.uri) ?? { activeCount: 0, lastUsedAtMs: null };
		cur.activeCount += 1;
		const at = Date.parse(r.at);
		if (Number.isFinite(at) && (cur.lastUsedAtMs === null || at > cur.lastUsedAtMs)) {
			cur.lastUsedAtMs = at;
		}
		out.set(r.uri, cur);
	}
	return out;
}

/** The D8-bounded used-ledger multiplier (see module header): m ∈ [1.0, 1.1]
 *  for h ∈ [0,1] — neutral at h=0 (never-used AND stale-decayed cards keep
 *  their score byte-identical), +10% at most for a heavily-used-just-now
 *  card. Reuses HOTNESS_ALPHA_MAX (0.1) as the bound, per the ticket. */
export function hotnessMultiplier(hotness: number): number {
	return 1 + HOTNESS_ALPHA_MAX * hotness;
}

/** A card's multiplier given the ledger aggregates: uri-keyed first (the
 *  ledger's native key = RetrievedCard.id at write time), filename-stem
 *  fallback (cards whose id is the slug, or uri drift after a re-ingest
 *  renamed the source_id). Absent from both → m=1.0 (never-used, neutral).
 *  `now` is injected — deterministic tests, no library clock. */
export function usedLedgerMultiplier(
	aggregates: ReadonlyMap<string, UsageAggregate>,
	id: string,
	stem: string,
	now: number,
): number {
	const a = aggregates.get(id) ?? aggregates.get(stem);
	if (!a) return 1;
	return hotnessMultiplier(hotnessScore(a.activeCount, a.lastUsedAtMs, now));
}
