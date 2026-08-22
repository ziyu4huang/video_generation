/**
 * Unit tests for the pure aggregation hierarchy core (ticket 02, effort
 * 2026-08-16-leanrag-hierarchy-port).
 *
 * Deterministic fixtures only — hand-crafted vectors (two tight groups + one
 * outlier), a counting fake summarizeFn, and a keyword fake embedFn. These pin
 * the D5 cluster boundaries, the D6 budget gate (LLM NEVER called under
 * budget), the stopping rule (≤4 nodes / depth cap), D2 checkpoint round-trip
 * + resume shape, and the cycle-safe parent-chain walk.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildLayer,
	cluster,
	composeSummary,
	parentChain,
	readCheckpoint,
	truncateSummary,
	writeCheckpoint,
	type AggregationNode,
	type ClusterItem,
} from "../src/hierarchy.ts";

// ---------------------------------------------------------------------------
// Fixtures — hand-crafted 2D vectors, no RNG
// ---------------------------------------------------------------------------

/** Two tight groups (alpha≈+x, beta≈+y) + one outlier (zeta≈−x). Within-group
 *  cosine ≈ 0.98; cross-group ≈ 0.10 — far either side of the 0.72 default. */
const GROUP_A: number[][] = [
	[1, 0.1],
	[1, -0.1],
];
const GROUP_B: number[][] = [
	[0.1, 1],
	[-0.1, 1],
];
const OUTLIER = [-1, 0];

function items(): ClusterItem[] {
	return [
		{ id: "card-a1", vector: GROUP_A[0] },
		{ id: "card-a2", vector: GROUP_A[1] },
		{ id: "card-b1", vector: GROUP_B[0] },
		{ id: "card-b2", vector: GROUP_B[1] },
		{ id: "card-x", vector: OUTLIER },
	];
}

/** Keyword fake embedFn: deterministic text→vector (no model, no network).
 *  Non-alpha/beta directions sit ≥72° apart (pairwise cosine ≤ 0.31 ≪ 0.72)
 *  so singleton topics never accidentally cluster together. */
function fakeEmbedFn(texts: string[]): Promise<number[][]> {
	return Promise.resolve(
		texts.map((t) => {
			if (t.startsWith("alpha")) return [1, 0.1];
			if (t.startsWith("beta")) return [0.309, 0.951];
			if (t.startsWith("zeta")) return [-0.809, 0.588];
			if (t.startsWith("delta")) return [-0.809, -0.588];
			if (t.startsWith("epsilon")) return [0.309, -0.951];
			return [0, 0]; // zero vector → cosine 0 → own cluster
		}),
	);
}

/** Counting fake summarizeFn — records every (over-budget) invocation. */
let summarizeCalls = 0;
function fakeSummarizeFn(clusterText: string, _budget: number): Promise<string> {
	summarizeCalls++;
	return Promise.resolve(`SUM(${clusterText.length})`);
}

// ---------------------------------------------------------------------------
// (a) cluster boundaries at threshold
// ---------------------------------------------------------------------------

describe("cluster", () => {
	test("default threshold → two tight groups + outlier singleton", () => {
		const result = cluster(items());
		expect(result).toEqual([
			["card-a1", "card-a2"],
			["card-b1", "card-b2"],
			["card-x"],
		]);
	});

	test("high threshold (0.999) → nothing joins, all singletons", () => {
		const result = cluster(items(), { threshold: 0.999 });
		expect(result.every((g) => g.length === 1)).toBe(true);
		expect(result).toHaveLength(5);
	});

	test("threshold 0 → non-opposed items merge; outlier still excluded", () => {
		const result = cluster(items(), { threshold: 0, minSize: 1 });
		expect(result).toHaveLength(2);
		expect(result[0]).toHaveLength(4); // a+b groups fold together (cos ≥ 0)
		expect(result[1]).toEqual(["card-x"]); // cosine −1 → never joins
	});

	test("id-sort makes greedy order deterministic regardless of input order", () => {
		const shuffled = [...items()].reverse();
		expect(cluster(shuffled)).toEqual(cluster(items()));
	});

	test("minSize drops small clusters back to singletons", () => {
		const result = cluster(items(), { minSize: 3 });
		expect(result).toHaveLength(5); // no group of 3 → all singletons
		expect(result.every((g) => g.length === 1)).toBe(true);
	});

	test("empty input → empty result", () => {
		expect(cluster([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (b) buildLayer — D6 budget gating + node shape
// ---------------------------------------------------------------------------

const LONG = "alpha ".repeat(25); // 150 chars; joined pair = 310 → truncation band (>300, ≪ budget)

function layerCards() {
	return [
		{ id: "c-a1", text: `${LONG} one`, entities: ["mlx", "run.py"], sources: ["h1", "h2"] },
		{ id: "c-a2", text: `${LONG} two`, entities: ["mlx", "ltx"], sources: ["h2", "h3"] },
		{ id: "c-b1", text: "beta short", entities: ["gui"], sources: ["h4"] },
		{ id: "c-b2", text: "beta brief", entities: ["gui", "tui"], sources: ["h5"] },
	];
}

describe("buildLayer", () => {
	test("under budget → zero LLM calls, deterministic top-entity composition summaries", async () => {
		summarizeCalls = 0;
		const { nodes, llmCalls, done } = await buildLayer({
			cards: layerCards(),
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 10_000,
		});
		expect(llmCalls).toBe(0);
		expect(summarizeCalls).toBe(0);
		expect(done).toBe(true); // 2 nodes ≤ 4
		expect(nodes).toHaveLength(2);
		// alpha cluster (c-a1 sorts first → cluster index 0)
		const [alpha, beta] = nodes;
		expect(alpha.id).toBe("agg:0:0");
		expect(alpha.parentOf).toEqual(["c-a1", "c-a2"]);
		expect(alpha.entities).toEqual(["mlx", "run.py", "ltx"]);
		expect(alpha.sources).toEqual(["h1", "h2", "h3"]);
		expect(alpha.layer).toBe(0);
		expect(alpha.clusterSize).toBe(2);
		// ticket 06: deterministic summary = top-entity composition, not a raw
		// truncation — prefix "mlx、run.py、ltx：" + the normalized joined lead,
		// clamped to 300.
		expect(alpha.summary).toBe(composeSummary(["mlx", "run.py", "ltx"], [`${LONG} one`, `${LONG} two`].join("\n\n")));
		expect(alpha.summary.length).toBe(300);
		expect(alpha.summary.endsWith("…")).toBe(true);
		// beta joined (21 normalized chars ≤ room) → composition fits verbatim
		expect(beta.id).toBe("agg:0:1");
		expect(beta.parentOf).toEqual(["c-b1", "c-b2"]);
		expect(beta.entities).toEqual(["gui", "tui"]);
		expect(beta.summary).toBe("gui、tui：beta short beta brief");
	});

	test("over budget → one LLM call per over-budget cluster", async () => {
		summarizeCalls = 0;
		const { nodes, llmCalls } = await buildLayer({
			cards: layerCards(),
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 10, // both clusters' joined text > 10
		});
		expect(llmCalls).toBe(2);
		expect(summarizeCalls).toBe(2);
		expect(nodes[0].summary).toBe("SUM(310)"); // deterministic fake output
		expect(nodes[1].summary).toBe("SUM(22)");
	});

	test("mixed budget → only the long cluster pays for an LLM call", async () => {
		summarizeCalls = 0;
		const { llmCalls, nodes } = await buildLayer({
			cards: layerCards(),
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 50, // alpha 310 > 50 (LLM), beta 22 ≤ 50 (truncate)
		});
		expect(llmCalls).toBe(1);
		expect(nodes[0].summary).toBe("SUM(310)");
		// beta under budget → deterministic composition (entity head + lead)
		expect(nodes[1].summary).toBe("gui、tui：beta short beta brief");
	});

	test("empty cards → no nodes, no embed cost, done", async () => {
		const { nodes, llmCalls, done } = await buildLayer({
			cards: [],
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 100,
		});
		expect(nodes).toEqual([]);
		expect(llmCalls).toBe(0);
		expect(done).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (c) done flag — ≤4 nodes or depth cap
// ---------------------------------------------------------------------------

describe("buildLayer stopping rule", () => {
	function manyCards() {
		// 5 clusters: alpha pair, beta pair, zeta/delta/epsilon singletons
		return [
			{ id: "m-1", text: "alpha one", entities: [] },
			{ id: "m-2", text: "alpha two", entities: [] },
			{ id: "m-3", text: "beta one", entities: [] },
			{ id: "m-4", text: "beta two", entities: [] },
			{ id: "m-5", text: "zeta lone", entities: [] },
			{ id: "m-6", text: "delta solo", entities: [] },
			{ id: "m-7", text: "epsilon fly", entities: [] },
		];
	}

	test("5 nodes > 4 at depth 0 → not done", async () => {
		const { nodes, done } = await buildLayer({
			cards: manyCards(),
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 10_000,
		});
		expect(nodes).toHaveLength(5);
		expect(done).toBe(false);
	});

	test("depth cap (currentDepth ≥ maxDepth) → done even with many nodes", async () => {
		const { nodes, done } = await buildLayer({
			cards: manyCards(),
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 10_000,
			currentDepth: 3, // default maxDepth
		});
		expect(nodes).toHaveLength(5);
		expect(done).toBe(true);
		expect(nodes[0].id).toBe("agg:3:0"); // layer stamped from currentDepth
	});

	test("custom maxDepth → done at the overridden cap", async () => {
		const { done } = await buildLayer({
			cards: manyCards(),
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 10_000,
			currentDepth: 2,
			maxDepth: 2,
		});
		expect(done).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (d) checkpoints — round-trip + resume shape
// ---------------------------------------------------------------------------

const ckptDir = mkdtempSync(join(tmpdir(), "zk-hierarchy-"));
afterAll(() => rmSync(ckptDir, { recursive: true, force: true }));

describe("checkpoints", () => {
	test("write → read round-trips the layer payload", async () => {
		const payload = {
			nodes: [{ id: "agg:2:0", parentOf: ["agg:1:0"], entities: ["mlx"], sources: ["h1"], summary: "s", layer: 2, clusterSize: 3 }],
			llmCalls: 3,
			done: false,
		};
		await writeCheckpoint(ckptDir, 2, payload);
		expect(existsSync(join(ckptDir, "hierarchy-layer-2.json"))).toBe(true);
		const read = (await readCheckpoint(ckptDir, 2)) as typeof payload;
		expect(read).toEqual(payload); // resume reads the written shape verbatim
		// atomic-ish: no .tmp leftovers
		expect(readdirSync(ckptDir).some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	test("missing layer → null (fresh/resume boundary)", async () => {
		expect(await readCheckpoint(ckptDir, 7)).toBeNull();
	});

	test("rewrite is idempotent per layer", async () => {
		await writeCheckpoint(ckptDir, 2, { nodes: [], llmCalls: 0, done: true });
		const read = (await readCheckpoint(ckptDir, 2)) as { done: boolean };
		expect(read.done).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (e) parentChain — walk 2 levels up, cycle-safe
// ---------------------------------------------------------------------------

function treeNodes(): AggregationNode[] {
	return [
		{ id: "agg:0:0", parentOf: ["card-1", "card-2"], entities: [], sources: [], summary: "l0a", layer: 0, clusterSize: 2 },
		{ id: "agg:0:1", parentOf: ["card-3"], entities: [], sources: [], summary: "l0b", layer: 0, clusterSize: 1 },
		{ id: "agg:1:0", parentOf: ["agg:0:0", "agg:0:1"], entities: [], sources: [], summary: "l1", layer: 1, clusterSize: 2 },
		{ id: "agg:2:0", parentOf: ["agg:1:0"], entities: [], sources: [], summary: "l2", layer: 2, clusterSize: 1 },
	];
}

describe("parentChain", () => {
	test("walks two levels up through parentOf", () => {
		const chain = parentChain("agg:0:0", treeNodes());
		expect(chain.map((n) => n.id)).toEqual(["agg:0:0", "agg:1:0", "agg:2:0"]);
	});

	test("root node → chain of just itself", () => {
		expect(parentChain("agg:2:0", treeNodes()).map((n) => n.id)).toEqual(["agg:2:0"]);
	});

	test("cycle → returns the partial chain, no hang", () => {
		const cyclic: AggregationNode[] = [
			{ id: "x", parentOf: ["y"], entities: [], sources: [], summary: "", layer: 0, clusterSize: 1 },
			{ id: "y", parentOf: ["x"], entities: [], sources: [], summary: "", layer: 0, clusterSize: 1 },
		];
		const chain = parentChain("x", cyclic);
		expect(chain.map((n) => n.id)).toEqual(["x", "y"]); // stops before re-entering x
	});

	test("unknown id → empty chain", () => {
		expect(parentChain("nope", treeNodes())).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (g) composeSummary — ticket 06 deterministic top-entity composition
// ---------------------------------------------------------------------------

describe("composeSummary", () => {
	test("top-3 entity head + normalized lead, clamped to the limit", () => {
		expect(composeSummary(["mlx", "run.py", "ltx"], "alpha one\n\nalpha two")).toBe("mlx、run.py、ltx：alpha one alpha two");
		// >3 entities → only the first 3 head the summary
		expect(composeSummary(["a", "b", "c", "d", "e"], "t")).toBe("a、b、c：t");
		// lead over room → ellipsis tail at exactly the limit
		const out = composeSummary(["e"], "x".repeat(400), 50);
		expect(out.length).toBe(50);
		expect(out.endsWith("…")).toBe(true);
	});

	test("no entities → bare lead (never an empty head)", () => {
		expect(composeSummary([], "just the text")).toBe("just the text");
		// blank entity names filtered out of the head
		expect(composeSummary(["  ", "e"], "t")).toBe("e：t");
	});

	test("wikilinks are unwrapped — a summary is text, not a link surface", () => {
		expect(composeSummary(["e"], "see [[pi-dynamic-workflows]] for details")).toBe("e：see pi-dynamic-workflows for details");
		// display-form links keep their label
		expect(composeSummary([], "[[target|label]] end")).toBe("label end");
	});
});
