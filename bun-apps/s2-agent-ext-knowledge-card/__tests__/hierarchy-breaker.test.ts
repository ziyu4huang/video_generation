/**
 * Ticket 02 tests — hang-mode circuit-breaker through the buildHierarchy
 * orchestration (plumbing: opts.summaryBreaker → buildLayer's input):
 *
 *  (a) summarizeFn stuck returning null — the build still completes, the
 *      breaker trips at K=3 (llmCalls capped at 3 for a 5-cluster layer 0;
 *      upper layers fall under the 1200-char budget floor so they never
 *      call the LLM), and no node carries an empty summary;
 *  (b) null×3 then valid with summaryBreaker 4 — the valid result RESETS
 *      the streak (no trip: all 5 layer-0 clusters still called) and the
 *      valid text is used for the nodes after the null run;
 *  (c) summaryBreaker 1 override — trips after a single empty result.
 *
 * Fixtures mirror hierarchy-build.test.ts: 5 topic directions ≥72° apart so
 * every layer yields 5 singleton-ish nodes, but leaf texts are ~2600 chars
 * (>1200 budget floor) so every layer-0 cluster is over budget and the
 * summarize path actually runs.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHierarchy } from "../src/hierarchy-build.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deterministic fake embedFn: text prefix → one of 5 directions ≥72° apart
 *  (pairwise cosine ≤ 0.41 ≪ 0.72) — same vocabulary as hierarchy.test.ts. */
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

/** Always-null summarizer (hang mode: LLM never returns usable text). */
const nullish = async (_t: string, _b: number): Promise<string> => null as unknown as string;

/** 7 leaf cards with ~2600-char texts (over the 1200 budget floor): alpha
 *  pair, beta pair, zeta/delta/epsilon singletons → layer 0 = 5 clusters,
 *  all over budget → the summarize path runs for every one of them. */
function leafCards() {
	const mk = (topic: string, n: number) =>
		Array.from({ length: n }, (_, i) => ({
			id: `c-${topic}-${i}`,
			text: `${topic} text ${i} `.repeat(200).trim(),
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

let kb: string;
beforeEach(() => {
	kb = mkdtempSync(join(tmpdir(), "zk-hierbreaker-"));
});
afterAll(() => {
	rmSync(kb, { recursive: true, force: true });
});

function opts() {
	return {
		kbDir: kb,
		cards: leafCards(),
		embedFn: fakeEmbedFn,
		summarizeFn: nullish,
		tokenBudget: 1_200, // every layer-0 cluster (≥2600 chars) exceeds it
		maxDepth: 2,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildHierarchy summaryBreaker (ticket 02)", () => {
	test("(a) null-always summarizer: build completes, trips at K=3, no empty summaries", async () => {
		const r = await buildHierarchy(opts());
		expect(r.layers).toBe(3); // depth cap 0,1,2 — the loop ran to the end
		expect(r.nodes).toHaveLength(15); // 5 nodes × 3 layers
		expect(r.skipped).toBeUndefined();
		// 5 over-budget clusters in layer 0, but the breaker trips on the 3rd
		// consecutive null → clusters 4-5 degrade without an LLM call. Upper
		// layers' texts (≤300-char truncations) sit under the 1200 floor, so
		// they add zero further calls: total 3, not 5.
		expect(r.llmCalls).toBe(3);
		// no empty summary ever propagates upward (layer N+1 text = summary)
		expect(r.nodes.every((n) => n.summary.length > 0)).toBe(true);
	});

	test("(b) null×3 then valid: streak resets, valid result used after", async () => {
		let call = 0;
		const flaky = async (_t: string, _b: number): Promise<string> => {
			call++;
			return call <= 3 ? (null as unknown as string) : `SUM-VALID-${call}`;
		};
		// K=4 isolates the reset: without it the 3-null streak + the 4th call
		// would reach 4 and trip; with the reset the valid 4th result zeroes
		// the streak, so all 5 layer-0 clusters get called.
		const r = await buildHierarchy({ ...opts(), summarizeFn: flaky, summaryBreaker: 4 });
		expect(r.llmCalls).toBe(5);
		// The two valid summaries embed to the same fallback direction (they
		// match no topic prefix), so layer 1 merges them into one cluster → 4
		// nodes → done(≤4): 2 layers total. That is fixture geometry, not the
		// breaker — the reset semantics live in the layer-0 asserts below.
		const layer0 = r.nodes.filter((n) => n.layer === 0);
		expect(layer0).toHaveLength(5);
		// the valid texts (4th and 5th calls) became those nodes' summaries;
		// the first three degraded to deterministic truncations, not empty
		const valid = layer0.filter((n) => n.summary.startsWith("SUM-VALID-"));
		expect(valid.map((n) => n.summary).sort()).toEqual(["SUM-VALID-4", "SUM-VALID-5"]);
		expect(r.nodes.every((n) => n.summary.length > 0)).toBe(true);
	});

	test("(c) summaryBreaker:1 override trips after a single empty result", async () => {
		const r = await buildHierarchy({ ...opts(), summaryBreaker: 1 });
		expect(r.layers).toBe(3); // build still completes end-to-end
		expect(r.nodes).toHaveLength(15);
		// first null already trips → clusters 2-5 skip the LLM entirely
		expect(r.llmCalls).toBe(1);
		expect(r.nodes.every((n) => n.summary.length > 0)).toBe(true);
	});
});
