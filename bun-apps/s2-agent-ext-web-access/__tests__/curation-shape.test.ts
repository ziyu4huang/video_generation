/**
 * curation-shape.test.ts — first tests for the curator's return-shaping spine.
 *
 * These five functions lived inside index.ts's `export default function (pi)`
 * closure until now, which made them unreachable from any test file. Every
 * assertion below is therefore new coverage, not a port: nothing had ever
 * executed `normalizeSummaryMeta`, `buildCurationCancelledReturn`,
 * `filterByQueryIndices`, `collectAllResultsAndUrls`, or
 * `resolveSummaryForSubmit` under test.
 *
 * The focus is the branches that decide what a user actually gets back — the
 * fallbacks when a field is absent or malformed, and the de-duplication that
 * multi-query search depends on.
 */
import { test, expect, describe } from "bun:test";
import {
	buildCurationCancelledReturn,
	collectAllResultsAndUrls,
	filterByQueryIndices,
	normalizeSummaryMeta,
	resolveSummaryForSubmit,
} from "../curation-shape.ts";
import type { SummaryMeta } from "../summary-review.ts";
import type { QueryResultData } from "../storage.ts";

function query(name: string, urls: string[], error: string | null = null): QueryResultData {
	return {
		query: name,
		answer: `answer for ${name}`,
		results: urls.map(u => ({ title: `title ${u}`, url: u, snippet: `snippet ${u}` })),
		error,
		provider: "exa",
	};
}

function resultMap(entries: Array<[number, QueryResultData]>): Map<number, QueryResultData> {
	return new Map(entries);
}

// ─── normalizeSummaryMeta ───────────────────────────────────────────────────

describe("normalizeSummaryMeta", () => {
	test("absent meta → fully populated record with an estimated token count", () => {
		const meta = normalizeSummaryMeta(undefined, "abcdefgh"); // 8 chars → ceil(8/4) = 2
		expect(meta).toEqual({
			model: null,
			durationMs: 0,
			tokenEstimate: 2,
			fallbackUsed: false,
			edited: false,
		});
	});

	test("absent meta with blank text → zero tokens, not one", () => {
		expect(normalizeSummaryMeta(undefined, "   ").tokenEstimate).toBe(0);
	});

	test("any non-empty text estimates at least one token", () => {
		expect(normalizeSummaryMeta(undefined, "a").tokenEstimate).toBe(1);
	});

	test("preserves a well-formed meta as-is", () => {
		const input: SummaryMeta = {
			model: "openai/gpt-x",
			durationMs: 1234,
			tokenEstimate: 99,
			fallbackUsed: true,
			fallbackReason: "timeout",
			edited: true,
		};
		expect(normalizeSummaryMeta(input, "some summary")).toEqual(input);
	});

	test("negative or non-finite durationMs is floored to 0", () => {
		const base = { model: null, tokenEstimate: 5, fallbackUsed: false };
		expect(normalizeSummaryMeta({ ...base, durationMs: -1 }, "text").durationMs).toBe(0);
		expect(normalizeSummaryMeta({ ...base, durationMs: NaN }, "text").durationMs).toBe(0);
		expect(normalizeSummaryMeta({ ...base, durationMs: Infinity }, "text").durationMs).toBe(0);
	});

	test("a bad tokenEstimate falls back to estimating from the text", () => {
		const base = { model: null, durationMs: 0, fallbackUsed: false };
		// "12345678" is 8 chars → 2 tokens.
		expect(normalizeSummaryMeta({ ...base, tokenEstimate: NaN }, "12345678").tokenEstimate).toBe(2);
		expect(normalizeSummaryMeta({ ...base, tokenEstimate: -3 }, "12345678").tokenEstimate).toBe(2);
	});

	test("a zero tokenEstimate is honoured, not treated as missing", () => {
		const base = { model: null, durationMs: 0, fallbackUsed: false };
		expect(normalizeSummaryMeta({ ...base, tokenEstimate: 0 }, "12345678").tokenEstimate).toBe(0);
	});

	test("fallbackUsed and edited are strict-true, so truthy non-booleans read as false", () => {
		const meta = normalizeSummaryMeta(
			{ model: null, durationMs: 0, tokenEstimate: 1, fallbackUsed: 1 as unknown as boolean },
			"text",
		);
		expect(meta.fallbackUsed).toBe(false);
		expect(meta.edited).toBe(false);
	});

	test("the text is trimmed before estimating", () => {
		// 8 significant chars surrounded by whitespace → still 2 tokens.
		expect(normalizeSummaryMeta(undefined, "   12345678   ").tokenEstimate).toBe(2);
	});
});

// ─── buildCurationCancelledReturn ───────────────────────────────────────────

describe("buildCurationCancelledReturn", () => {
	test("bare cancel names the reason and reports nothing it does not have", () => {
		const out = buildCurationCancelledReturn("user");
		expect(out.content).toEqual([{ type: "text", text: "Search curation cancelled (user)." }]);
		expect(out.details.cancelled).toBe(true);
		expect(out.details.cancelReason).toBe("user");
		expect(out.details.cancelledQueries).toBeUndefined();
		expect(out.details.extraLines).toBeUndefined();
	});

	test("a stale cancel is distinguishable from a user cancel", () => {
		const out = buildCurationCancelledReturn("stale");
		expect(out.details.cancelReason).toBe("stale");
		expect(out.details.error).toContain("stale");
	});

	test("partial results are reported rather than discarded", () => {
		const out = buildCurationCancelledReturn("stale", {
			queries: [query("a", ["https://x/1", "https://x/2"]), query("b", [], "boom")],
			queryCount: 2,
			browserConnected: false,
			lastHeartbeatAgeMs: 9000,
		});
		expect(out.details.cancelledQueries).toEqual([
			{ query: "a", provider: "exa", error: null, resultCount: 2 },
			{ query: "b", provider: "exa", error: "boom", resultCount: 0 },
		]);
		expect(out.details.queryCount).toBe(2);
		expect(out.details.lastHeartbeatAgeMs).toBe(9000);
	});

	test("an empty queries array stays undefined instead of becoming []", () => {
		expect(buildCurationCancelledReturn("user", { queries: [] }).details.cancelledQueries).toBeUndefined();
	});

	test("a missing provider is reported as null, not dropped", () => {
		const q = query("a", ["https://x/1"]);
		delete q.provider;
		const out = buildCurationCancelledReturn("user", { queries: [q] });
		expect(out.details.cancelledQueries?.[0]?.provider).toBeNull();
	});

	test("curator URL and browser error each contribute one extra line", () => {
		const out = buildCurationCancelledReturn("user", {
			curatorUrl: "http://localhost:1234",
			browserOpenError: "no browser",
		});
		expect(out.details.extraLines).toEqual([
			"curator: http://localhost:1234",
			"browser open error: no browser",
		]);
	});
});

// ─── filterByQueryIndices / collectAllResultsAndUrls ────────────────────────

describe("filterByQueryIndices", () => {
	const map = resultMap([
		[0, query("a", ["https://x/1", "https://x/2"])],
		[1, query("b", ["https://x/2", "https://x/3"])],
		[2, query("c", ["https://x/4"])],
	]);

	test("keeps only the selected queries", () => {
		const out = filterByQueryIndices([0, 2], map);
		expect(out.results.map(r => r.query)).toEqual(["a", "c"]);
	});

	test("de-duplicates URLs shared across selected queries", () => {
		// https://x/2 appears under both query a and query b.
		expect(filterByQueryIndices([0, 1], map).urls).toEqual([
			"https://x/1",
			"https://x/2",
			"https://x/3",
		]);
	});

	test("preserves the order the indices were selected in", () => {
		expect(filterByQueryIndices([2, 0], map).results.map(r => r.query)).toEqual(["c", "a"]);
	});

	test("unknown indices are skipped, not an error", () => {
		const out = filterByQueryIndices([0, 99], map);
		expect(out.results.map(r => r.query)).toEqual(["a"]);
	});

	test("no selection yields empty results and empty urls", () => {
		expect(filterByQueryIndices([], map)).toEqual({ results: [], urls: [] });
	});
});

describe("collectAllResultsAndUrls", () => {
	test("returns every query with URLs de-duplicated across them", () => {
		const map = resultMap([
			[0, query("a", ["https://x/1", "https://x/2"])],
			[1, query("b", ["https://x/2"])],
		]);
		const out = collectAllResultsAndUrls(map);
		expect(out.results.map(r => r.query)).toEqual(["a", "b"]);
		expect(out.urls).toEqual(["https://x/1", "https://x/2"]);
	});

	test("an empty map yields empty results and urls", () => {
		expect(collectAllResultsAndUrls(new Map())).toEqual({ results: [], urls: [] });
	});
});

// ─── resolveSummaryForSubmit ────────────────────────────────────────────────

describe("resolveSummaryForSubmit", () => {
	const map = resultMap([
		[0, query("a", ["https://x/1"])],
		[1, query("b", ["https://x/2"])],
	]);

	test("a submitted summary wins and is trimmed", () => {
		const out = resolveSummaryForSubmit(
			{ selectedQueryIndices: [0], summary: "  my own words  " },
			map,
		);
		expect(out.approvedSummary).toBe("my own words");
		expect(out.summaryMeta.fallbackUsed).toBe(false);
	});

	test("a whitespace-only summary is treated as absent, not as content", () => {
		const out = resolveSummaryForSubmit({ selectedQueryIndices: [0], summary: "   " }, map);
		expect(out.approvedSummary).not.toBe("");
		expect(out.summaryMeta.fallbackUsed).toBe(true);
	});

	test("no summary → deterministic fallback over the selected queries", () => {
		const out = resolveSummaryForSubmit({ selectedQueryIndices: [1] }, map);
		expect(out.summaryMeta.fallbackUsed).toBe(true);
		expect(out.summaryMeta.fallbackReason).toBe("deterministic-submit-fallback");
		expect(out.approvedSummary).toContain("https://x/2");
		expect(out.approvedSummary).not.toContain("https://x/1");
	});

	test("no summary and no surviving selection → falls back to every query", () => {
		// Index 99 matches nothing, so the filter is empty and everything is used.
		const out = resolveSummaryForSubmit({ selectedQueryIndices: [99] }, map);
		expect(out.approvedSummary).toContain("https://x/1");
		expect(out.approvedSummary).toContain("https://x/2");
	});

	test("the fallback is never an empty string, even with no results at all", () => {
		const out = resolveSummaryForSubmit({ selectedQueryIndices: [] }, new Map());
		expect(out.approvedSummary.trim().length).toBeGreaterThan(0);
		expect(out.summaryMeta.fallbackUsed).toBe(true);
	});

	test("a submitted summary carries its own meta through normalization", () => {
		const out = resolveSummaryForSubmit(
			{
				selectedQueryIndices: [0],
				summary: "edited text",
				summaryMeta: { model: "openai/gpt-x", durationMs: -5, tokenEstimate: 42, fallbackUsed: false, edited: true },
			},
			map,
		);
		expect(out.summaryMeta.model).toBe("openai/gpt-x");
		expect(out.summaryMeta.durationMs).toBe(0); // normalized
		expect(out.summaryMeta.tokenEstimate).toBe(42);
		expect(out.summaryMeta.edited).toBe(true);
	});
});
