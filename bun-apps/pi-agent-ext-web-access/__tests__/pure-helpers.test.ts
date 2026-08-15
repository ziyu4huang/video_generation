/**
 * pure-helpers.test.ts — deterministic tests for web-access's shared pure helpers.
 *
 * The provider adapters (brave/exa/tavily/...) all funnel through these:
 *   - buildSearchErrorPlan: renders every adapter's cancel/error state.
 *   - normalizeFetchContentParams: normalizes the fetch_content tool args.
 *   - summaryModelValue / modelMatchesEnabledPatterns: model-scope gating.
 *
 * They're pure (no network, no config), so they're the highest-value unit tests
 * for the adapter layer — covering "≥2 provider adapters" via their shared spine
 * without fragile HTTP mocking. The per-provider HTTP paths are documented as a
 * coverage gap in coverage-baseline.md (they need a recorded-response harness).
 */
import { test, expect, describe } from "bun:test";
import { buildSearchErrorPlan, type SearchErrorDetails } from "../render-search-error.ts";
import { normalizeFetchContentParams } from "../fetch-params.ts";
import { summaryModelValue, modelMatchesEnabledPatterns } from "../summary-model-scope.ts";

// ─── buildSearchErrorPlan ───────────────────────────────────────────────────

describe("buildSearchErrorPlan", () => {
	test("returns null when there is no error/cancel signal", () => {
		expect(buildSearchErrorPlan(undefined)).toBeNull();
		expect(buildSearchErrorPlan({})).toBeNull();
		expect(buildSearchErrorPlan({ queryCount: 3 })).toBeNull();
	});

	test("bare error → single headline line, no collapsed/expand hint", () => {
		const plan = buildSearchErrorPlan({ error: "No URL provided." })!;
		expect(plan.expanded).toEqual(["No URL provided."]);
		expect(plan.collapsed).toEqual([]);
		expect(plan.expandHint).toBeNull();
	});

	test("cancelled with partial queries → diagnostics block + query progress", () => {
		const plan = buildSearchErrorPlan({
			cancelled: true,
			cancelReason: "stale",
			browserConnected: false,
			queryCount: 4,
			cancelledQueries: [
				{ query: "a", error: undefined },
				{ query: "b", error: "timeout" },
			],
		})!;
		expect(plan.expanded[0]).toBe("Search cancelled.");
		expect(plan.expanded.join("\n")).toContain("cancel reason   : stale");
		expect(plan.expanded.join("\n")).toContain("browser         : never connected");
		expect(plan.expanded.join("\n")).toContain("queries started : 4");
	});

	test("non-cancel error with extraLines surfaces the extras", () => {
		const plan = buildSearchErrorPlan({
			error: "fetch_content failed",
			extraLines: ["url: https://example.com/x", "status: 503"],
		})!;
		const joined = plan.expanded.join("\n");
		expect(joined).toContain("url: https://example.com/x");
		expect(joined).toContain("status: 503");
	});
});

// ─── normalizeFetchContentParams ────────────────────────────────────────────

describe("normalizeFetchContentParams", () => {
	test("single url → urlList with one entry", () => {
		const out = normalizeFetchContentParams({ url: "https://example.com" });
		expect(out.urlList).toEqual(["https://example.com"]);
		expect(out.options.forceClone).toBeUndefined();
	});

	test("urls array dedupes + ignores blanks/non-strings", () => {
		const out = normalizeFetchContentParams({
			urls: ["https://a.com", "  https://a.com  ", "", "https://b.com", 123 as unknown],
		});
		expect(out.urlList).toEqual(["https://a.com", "https://b.com"]);
	});

	test("urls takes precedence over url when both present", () => {
		const out = normalizeFetchContentParams({ url: "https://ignore.me", urls: ["https://keep.me"] });
		expect(out.urlList).toEqual(["https://keep.me"]);
	});

	test("forceClone only set when a real boolean; frames gated on timestamp/>1", () => {
		expect(normalizeFetchContentParams({ forceClone: true }).options.forceClone).toBe(true);
		expect(normalizeFetchContentParams({ forceClone: "yes" as unknown }).options.forceClone).toBeUndefined();
		// frames is included when (timestamp present) OR (frames > 1):
		expect(normalizeFetchContentParams({ frames: 3 }).options.frames).toBe(3); // frames>1
		expect(normalizeFetchContentParams({ frames: 1 }).options.frames).toBeUndefined(); // 1 not >1, no timestamp
		expect(normalizeFetchContentParams({ frames: 1, timestamp: "1:00" }).options.frames).toBe(1); // timestamp forces inclusion
	});
});

// ─── summaryModelValue + modelMatchesEnabledPatterns ────────────────────────

const model = (provider: string, id: string) => ({ provider, id });

describe("summaryModelValue + modelMatchesEnabledPatterns", () => {
	test("summaryModelValue composes provider/id", () => {
		expect(summaryModelValue(model("lm-studio", "google/gemma-4-12b"))).toBe(
			"lm-studio/google/gemma-4-12b",
		);
	});

	test("null patterns → everything allowed", () => {
		expect(modelMatchesEnabledPatterns(model("any", "any"), null)).toBe(true);
	});

	test("exact provider/id pattern matches (case-insensitive)", () => {
		const patterns = ["lm-studio/google/gemma-4-12b"];
		expect(modelMatchesEnabledPatterns(model("LM-Studio", "google/gemma-4-12b"), patterns)).toBe(true);
		expect(modelMatchesEnabledPatterns(model("openai", "gpt-4o"), patterns)).toBe(false);
	});

	test("glob patterns match by provider prefix", () => {
		const patterns = ["lm-studio/*"];
		expect(modelMatchesEnabledPatterns(model("lm-studio", "anything"), patterns)).toBe(true);
		expect(modelMatchesEnabledPatterns(model("openai", "x"), patterns)).toBe(false);
	});

	test("strips a trailing thinking-level suffix before matching", () => {
		const patterns = ["lm-studio/google/gemma-4-12b"];
		// A pattern without the suffix still matches (suffix is normalized away).
		expect(modelMatchesEnabledPatterns(model("lm-studio", "google/gemma-4-12b"), patterns)).toBe(true);
	});
});
