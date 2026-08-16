/**
 * curation-shape.ts — pure shaping of what the browser curator hands back.
 *
 * These five helpers were nested inside index.ts's `export default function (pi)`
 * closure, but none of them touch `pi` or any closed-over state: they are total
 * functions of their arguments. Nesting them there had two costs. They sat under
 * index.ts's file-wide `// @ts-nocheck`, so no checker ever saw them; and being
 * closure-scoped they were unreachable from a test file, so no test ever ran
 * them either. Hoisting them here restores both.
 *
 * The split follows the shape the package already uses for its pure spine —
 * fetch-params.ts, summary-model-scope.ts, render-search-error.ts — each a small
 * module of argument-only functions covered by __tests__/pure-helpers.test.ts.
 *
 * Scope boundary: "shaping", not "producing". Deciding WHAT to summarize or
 * calling a model lives in summary-review.ts; normalizing and packaging the
 * result for return lives here.
 */
import type { QueryResultData } from "./storage.ts";
import { buildDeterministicSummary, type SummaryMeta } from "./summary-review.ts";

/** ~4 chars per token — the estimate used when a model reports no token count. */
function estimateTokens(text: string): number {
	return text.length > 0 ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

/**
 * Fills in a complete SummaryMeta from a partial/absent one.
 *
 * A summary can arrive from a model (meta present), from the deterministic
 * fallback, or straight from the user's edit box (meta absent). Callers
 * downstream read every field unconditionally, so every path must produce a
 * fully-populated record — including a token estimate derived from the text
 * when the source reported none, and a non-negative duration.
 */
export function normalizeSummaryMeta(meta: SummaryMeta | undefined, summaryText: string): SummaryMeta {
	const normalizedText = summaryText.trim();
	if (!meta) {
		return {
			model: null,
			durationMs: 0,
			tokenEstimate: estimateTokens(normalizedText),
			fallbackUsed: false,
			edited: false,
		};
	}

	return {
		model: meta.model,
		durationMs: Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? meta.durationMs : 0,
		tokenEstimate: Number.isFinite(meta.tokenEstimate) && meta.tokenEstimate >= 0
			? meta.tokenEstimate
			: estimateTokens(normalizedText),
		fallbackUsed: meta.fallbackUsed === true,
		fallbackReason: meta.fallbackReason,
		edited: meta.edited === true,
	};
}

export interface CurationCancelledPartial {
	queries?: QueryResultData[];
	queryCount?: number;
	browserConnected?: boolean;
	lastHeartbeatAgeMs?: number | null;
	curatorUrl?: string;
	browserOpenError?: string;
}

/**
 * The tool return for a curation that ended without a submit.
 *
 * `reason` distinguishes the two ways that happens: "user" (explicitly
 * cancelled) and "stale" (the curator stopped heartbeating). Whatever partial
 * results were already collected are reported rather than discarded, so the
 * caller can see how far the search got before it was cut off.
 */
export function buildCurationCancelledReturn(
	reason: "user" | "stale",
	partial?: CurationCancelledPartial,
) {
	const message = `Search curation cancelled (${reason}).`;
	const cancelledQueries = partial?.queries?.length
		? partial.queries.map(q => ({
			query: q.query,
			provider: q.provider ?? null,
			error: q.error,
			resultCount: q.results?.length ?? 0,
		}))
		: undefined;
	const extraLines: string[] = [];
	if (partial?.curatorUrl) extraLines.push(`curator: ${partial.curatorUrl}`);
	if (partial?.browserOpenError) extraLines.push(`browser open error: ${partial.browserOpenError}`);
	return {
		content: [{ type: "text" as const, text: message }],
		details: {
			error: message,
			cancelled: true,
			cancelReason: reason,
			browserConnected: partial?.browserConnected,
			lastHeartbeatAgeMs: partial?.lastHeartbeatAgeMs,
			queryCount: partial?.queryCount,
			cancelledQueries,
			extraLines: extraLines.length > 0 ? extraLines : undefined,
		},
	};
}

/**
 * Narrows the result map to the query indices the user kept, preserving the
 * order they were selected in and de-duplicating URLs across queries (the same
 * source commonly appears under several of the 2–4 varied-angle queries).
 *
 * Unknown indices are skipped rather than treated as an error: the curator page
 * and this process can disagree transiently if a query errored after render.
 */
export function filterByQueryIndices(selectedQueryIndices: number[], results: Map<number, QueryResultData>) {
	const filteredResults: QueryResultData[] = [];
	const filteredUrls: string[] = [];
	for (const qi of selectedQueryIndices) {
		const r = results.get(qi);
		if (r) {
			filteredResults.push(r);
			for (const res of r.results) {
				if (!filteredUrls.includes(res.url)) filteredUrls.push(res.url);
			}
		}
	}
	return { results: filteredResults, urls: filteredUrls };
}

/** The unfiltered counterpart of filterByQueryIndices — every query, URLs de-duplicated. */
export function collectAllResultsAndUrls(resultsByIndex: Map<number, QueryResultData>) {
	const results = [...resultsByIndex.values()];
	const urls: string[] = [];
	for (const result of results) {
		for (const source of result.results) {
			if (!urls.includes(source.url)) urls.push(source.url);
		}
	}
	return { results, urls };
}

/**
 * Picks the summary that a curator submit should return.
 *
 * The user's own text wins whenever they typed one. Otherwise we synthesize a
 * deterministic summary — from their selected queries if any survived the
 * filter, else from everything, so that a submit with no selection still
 * returns content rather than an empty string.
 */
export function resolveSummaryForSubmit(
	payload: { selectedQueryIndices: number[]; summary?: string; summaryMeta?: SummaryMeta },
	resultsByIndex: Map<number, QueryResultData>,
): { approvedSummary: string; summaryMeta: SummaryMeta } {
	const submittedSummary = typeof payload.summary === "string" ? payload.summary.trim() : "";
	if (submittedSummary.length > 0) {
		return {
			approvedSummary: submittedSummary,
			summaryMeta: normalizeSummaryMeta(payload.summaryMeta, submittedSummary),
		};
	}

	const selected = filterByQueryIndices(payload.selectedQueryIndices, resultsByIndex).results;
	const fallbackResults = selected.length > 0 ? selected : [...resultsByIndex.values()];
	const deterministic = buildDeterministicSummary(fallbackResults);
	return {
		approvedSummary: deterministic.summary,
		summaryMeta: deterministic.meta,
	};
}
