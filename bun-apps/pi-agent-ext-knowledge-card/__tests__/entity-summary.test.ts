/**
 * __tests__/entity-summary.test.ts — TDD for ⑥ entity summaries (ticket 03 P2-T4).
 *
 * Contract under test (plan: .planning/2026-08-08-knowledge-pipeline/plans/
 * 03-phase2-llm-relation-extractor.md Task 4):
 *  - estimateTokens: ceil(chars/4) heuristic, 0 → 0.
 *  - mergeDescriptions: filters empties, joins " | ".
 *  - condenseSummary: under-threshold → text unchanged, NO chat call
 *    (injected _fetchImpl that throws if invoked); over-threshold →
 *    canned-chat condensed string; chat null → ORIGINAL merged text.
 *  - summarizeEntity: merge + condense + memoize into cache (keyed by the
 *    merged input text — deterministic, avoids repeat chat calls).
 *  - load/save round-trip in a temp dir; corrupt JSON → {}; version
 *    envelope: mismatched version (v1) or old plain-object shape → {}
 *    (wholesale reset — cache is derived, regenerates lazily).
 *  - augmentEmbedText: undefined → base unchanged; with summary → prefixed,
 *    capped at 1000 chars total.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
	ENTITY_SUMMARY_CACHE_VERSION,
	SUMMARY_TOKEN_THRESHOLD,
	augmentEmbedText,
	condenseSummary,
	estimateTokens,
	loadEntitySummaries,
	mergeDescriptions,
	saveEntitySummaries,
	summarizeEntity,
	type EntitySummaryCache,
} from "../src/entity-summary.ts";

/** LM-Studio-shaped chat response for a given content string. */
function chatResponse(content: string): Response {
	return new Response(
		JSON.stringify({ choices: [{ message: { content } }] }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/**
 * Bun's `typeof fetch` requires the `preconnect` static that plain async
 * closures lack — cast through unknown to keep mocks one-liners (same
 * pattern as llm-chat.test.ts).
 */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
function asFetch(f: FetchLike): typeof fetch {
	return f as unknown as typeof fetch;
}

const tmpDirs: string[] = [];
afterAll(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("estimateTokens", () => {
	test("0 chars → 0", () => {
		expect(estimateTokens("")).toBe(0);
	});
	test("8 chars → 2", () => {
		expect(estimateTokens("abcdefgh")).toBe(2);
	});
	test("ceil: 9 chars → 3", () => {
		expect(estimateTokens("abcdefghi")).toBe(3);
	});
});

describe("mergeDescriptions", () => {
	test("filters empties and joins with ' | '", () => {
		expect(mergeDescriptions(["a", "", "b", "  ", "c"])).toBe("a | b | c");
	});
	test("all empty → empty string", () => {
		expect(mergeDescriptions(["", "  "])).toBe("");
	});
});

describe("condenseSummary", () => {
	test("under threshold → text unchanged, NO chat call", async () => {
		const short = "x".repeat(SUMMARY_TOKEN_THRESHOLD * 4); // exactly 512 tokens → not over
		let called = false;
		const res = await condenseSummary(short, {
			_fetchImpl: asFetch(() => {
				called = true;
				throw new Error("chat must not be called under threshold");
			}),
		});
		expect(res).toBe(short);
		expect(called).toBe(false);
	});

	test("over threshold → canned chat returns condensed string", async () => {
		const long = "y".repeat((SUMMARY_TOKEN_THRESHOLD + 10) * 4);
		const res = await condenseSummary(long, {
			_fetchImpl: asFetch(async () => chatResponse("condensed facts.")),
		});
		expect(res).toBe("condensed facts.");
	});

	test("strips markdown fences from chat output", async () => {
		const long = "y".repeat((SUMMARY_TOKEN_THRESHOLD + 10) * 4);
		const res = await condenseSummary(long, {
			_fetchImpl: asFetch(async () => chatResponse("```\nfenced summary\n```")),
		});
		expect(res).toBe("fenced summary");
	});

	test("chat null (unparseable) → ORIGINAL merged text", async () => {
		const long = "z".repeat((SUMMARY_TOKEN_THRESHOLD + 5) * 4);
		const res = await condenseSummary(long, {
			_fetchImpl: asFetch(async () => new Response("not json", { status: 200 })),
		});
		expect(res).toBe(long);
	});
});

describe("summarizeEntity", () => {
	test("memoizes into cache (always, idempotent)", async () => {
		const cache: EntitySummaryCache = {};
		const res = await summarizeEntity(["alpha", "beta"], { cache });
		expect(res).toBe("alpha | beta");
		expect(cache["alpha | beta"]).toBe("alpha | beta");
		// Cached hit short-circuits the chat call entirely. A `called` flag
		// makes this a real assertion: with memoization deleted, chatJson
		// swallows the throwing fetch and falls back to the merged text — the
		// same string — so only the flag distinguishes short-circuit from
		// silent chat failure.
		let called = false;
		const res2 = await summarizeEntity(["alpha", "beta"], {
			chat: {
				_fetchImpl: asFetch(() => {
					called = true;
					throw new Error("chat must not be called on cache hit");
				}),
			},
			cache,
		});
		expect(res2).toBe("alpha | beta");
		expect(called).toBe(false);
	});

	test("condense path over threshold + memoization with provided key", async () => {
		const cache: EntitySummaryCache = {};
		const descs = Array.from({ length: 60 }, (_, i) => `desc ${i} ` + "d".repeat(40));
		const res = await summarizeEntity(descs, {
			chat: { _fetchImpl: asFetch(async () => chatResponse("condensed.")) },
			cache,
		});
		expect(res).toBe("condensed.");
	});

	test("never throws when chat impl throws", async () => {
		const descs = Array.from({ length: 60 }, (_, i) => `desc ${i} ` + "d".repeat(40));
		const res = await summarizeEntity(descs, {
			chat: {
				_fetchImpl: asFetch(() => {
					throw new Error("network gone");
				}),
			},
		});
		expect(res).toBe(mergeDescriptions(descs));
	});
});

describe("entity summary cache load/save", () => {
	test("round-trip in temp dir; missing → {}", () => {
		const dir = mkdtempSync(join(tmpdir(), "es-"));
		tmpDirs.push(dir);
		expect(loadEntitySummaries(dir, "model/x")).toEqual({});
		const cache: EntitySummaryCache = { "person:ada": "summary text" };
		saveEntitySummaries(dir, "model/x", cache);
		expect(loadEntitySummaries(dir, "model/x")).toEqual(cache);
		// path shape mirrors semantic.ts; disk shape is the version envelope
		const p = join(dir, ".knowledge-semantic", "entity-summaries-model-x.json");
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({
			version: ENTITY_SUMMARY_CACHE_VERSION,
			entries: cache,
		});
	});

	test("corrupt JSON load → {}", () => {
		const dir = mkdtempSync(join(tmpdir(), "es-"));
		tmpDirs.push(dir);
		mkdirSync(join(dir, ".knowledge-semantic"), { recursive: true });
		const p = join(dir, ".knowledge-semantic", "entity-summaries-model-x.json");
		writeFileSync(p, "{ not json", "utf8");
		expect(loadEntitySummaries(dir, "model/x")).toEqual({});
	});

	test("version mismatch (v1 envelope) → wholesale reset to {}", () => {
		const dir = mkdtempSync(join(tmpdir(), "es-"));
		tmpDirs.push(dir);
		mkdirSync(join(dir, ".knowledge-semantic"), { recursive: true });
		const p = join(dir, ".knowledge-semantic", "entity-summaries-model-x.json");
		writeFileSync(
			p,
			JSON.stringify({ version: ENTITY_SUMMARY_CACHE_VERSION - 1, entries: { "k": "stale" } }),
			"utf8",
		);
		expect(loadEntitySummaries(dir, "model/x")).toEqual({});
	});

	test("old-shape file (plain object, no version envelope) → treated as empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "es-"));
		tmpDirs.push(dir);
		mkdirSync(join(dir, ".knowledge-semantic"), { recursive: true });
		const p = join(dir, ".knowledge-semantic", "entity-summaries-model-x.json");
		// pre-v2 on-disk shape: { [mergedText]: summary } directly, no wrapper
		writeFileSync(p, JSON.stringify({ "person:ada": "legacy summary" }), "utf8");
		expect(loadEntitySummaries(dir, "model/x")).toEqual({});
	});
});

describe("augmentEmbedText", () => {
	test("undefined summary → base unchanged", () => {
		expect(augmentEmbedText("base text", undefined)).toBe("base text");
	});
	test("summary prefixes base, capped at 1000 total", () => {
		const base = "b".repeat(950);
		const res = augmentEmbedText(base, "s".repeat(300));
		expect(res.length).toBe(1000);
		expect(res.startsWith("s".repeat(200))).toBe(true);
	});
});
