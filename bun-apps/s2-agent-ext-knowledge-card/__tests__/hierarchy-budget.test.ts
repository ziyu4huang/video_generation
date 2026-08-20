/**
 * Ticket 06 tests — per-layer budget schedule + chatJson-backed default
 * summarizer: (a) layerBudgetOf halving table (floor 1200), (b) defaultSummary
 * deterministic truncation when the LLM is down (never throws), (c) happy
 * path via the llm-chat `_fetchImpl` fixture shape (postChat reads
 * res.json().choices[0].message — mimic llm-chat.test.ts), (d) orchestration
 * budget gating holds on the DEFAULT path: huge tokenBudget → llmCalls === 0
 * and the default summarizer's fetch is never called.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHierarchy, defaultSummary, layerBudgetOf } from "../src/hierarchy-build.ts";
import type { LmChatOptions } from "../src/llm-chat.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deterministic fake embedFn: text prefix → one of 5 directions ≥72° apart
 *  (same vector vocabulary as hierarchy-build.test.ts). */
function fakeEmbedFn(texts: string[]): Promise<number[][]> {
	return Promise.resolve(
		texts.map((t) => {
			if (t.startsWith("alpha")) return [1, 0.1];
			if (t.startsWith("beta")) return [0.309, 0.951];
			if (t.startsWith("zeta")) return [-0.809, 0.588];
			if (t.startsWith("delta")) return [-0.809, -0.588];
			return [0.309, -0.951]; // epsilon
		}),
	);
}

/** 7 leaf cards: alpha pair, beta pair, zeta/delta/epsilon singletons —
 *  under-budget clusters get truncateSummary (300-char cap keeps the topic
 *  prefix), so every layer re-embeds to the same 5 directions. */
function leafCards() {
	const mk = (topic: string, n: number) =>
		Array.from({ length: n }, (_, i) => ({
			id: `c-${topic}-${i}`,
			text: `${topic} text ${i} `.repeat(6).trim(),
			entities: [`${topic}-entity`],
			sources: [`h-${topic}-${i}`],
		}));
	return [
		...mk("alpha", 2),
		...mk("beta", 2),
		...mk("zeta", 1),
		...mk("delta", 1),
		...mk("epsilon", 1),
	];
}

/** llm-chat.test.ts fixture shape: OpenAI chat-completions body with the
 *  given assistant content — postChat reads res.json().choices[0].message. */
function okChat(content: string): Response {
	return new Response(
		JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/** Bun's `typeof fetch` requires statics plain closures lack (llm-chat.test.ts). */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const asFetch = (f: FetchLike): typeof fetch => f as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("layerBudgetOf", () => {
	test("(a) halves the base per depth, floor 1200", () => {
		expect(layerBudgetOf(0, 10_000)).toBe(10_000);
		expect(layerBudgetOf(1, 10_000)).toBe(5_000);
		expect(layerBudgetOf(2, 10_000)).toBe(2_500);
		expect(layerBudgetOf(3, 10_000)).toBe(1_250);
		expect(layerBudgetOf(4, 10_000)).toBe(1_200); // floor
	});
});

describe("defaultSummary", () => {
	test("(b) LLM down → deterministic truncation fallback, no throw", async () => {
		const down: LmChatOptions = {
			_fetchImpl: asFetch(async () => {
				throw new Error("down");
			}),
		};
		// norm("word "×10) = 49 chars; budget 8 → slice(0,7) + ellipsis
		const out = await defaultSummary("word ".repeat(10), 8, down);
		expect(out).toBe("word wo…");
	});

	test("(c) happy path: parseable chatJson body → extracted summary", async () => {
		const plain: LmChatOptions = {
			_fetchImpl: asFetch(async () => okChat('{"summary":"densified"}')),
		};
		expect(await defaultSummary("cluster text body", 100, plain)).toBe("densified");
		// fenced ```json blocks tolerated by the parseFn
		const fenced: LmChatOptions = {
			_fetchImpl: asFetch(async () => okChat('```json\n{"summary":"densified"}\n```')),
		};
		expect(await defaultSummary("cluster text body", 100, fenced)).toBe("densified");
	});
});

describe("buildHierarchy default-path gating", () => {
	let kb: string;
	beforeEach(() => {
		kb = mkdtempSync(join(tmpdir(), "zk-hierbudget-"));
	});
	afterAll(() => {
		rmSync(kb, { recursive: true, force: true });
	});

	test("(d) huge tokenBudget → llmCalls === 0, default summarizer's fetch never called", async () => {
		let fetchCalls = 0;
		const r = await buildHierarchy({
			kbDir: kb,
			cards: leafCards(),
			embedFn: fakeEmbedFn,
			tokenBudget: 1e9, // no summarizeFn → DEFAULT (chatJson-backed) path
			_chatOpts: {
				_fetchImpl: asFetch(async () => {
					fetchCalls++;
					return okChat('{"summary":"should-never-run"}');
				}),
			},
		});
		expect(r.llmCalls).toBe(0); // every cluster under budget → no summarize
		expect(fetchCalls).toBe(0); // …so the default summarizer never touched the LLM
	});
});
