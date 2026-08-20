/**
 * Ticket 04a tests — zk-side buildHierarchy orchestration: (a) multi-layer
 * build leaves per-layer checkpoints + derived agg MOC files on disk,
 * (b) a second call resumes (all layers skipped — zero embed calls),
 * (c) empty entities → skipped, (d) the D6 budget gate holds through the
 * whole loop (llmCalls === 0 with a huge tokenBudget).
 *
 * Deterministic fixtures only — 5 topic directions ≥72° apart (same vector
 * vocabulary as hierarchy.test.ts) so layer-0 yields 5 nodes (>4 → not done),
 * node summaries re-embed to the same directions, and the build runs to the
 * depth cap (maxDepth 2 → 3 layers × 5 nodes).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHierarchy } from "../src/hierarchy-build.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const embedCalls: number[] = [];

/** Deterministic fake embedFn: text prefix → one of 5 directions ≥72° apart
 *  (pairwise cosine ≤ 0.41 ≪ 0.72). Counts batches for the resume test. */
function fakeEmbedFn(texts: string[]): Promise<number[][]> {
	embedCalls.push(texts.length);
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

let summarizeCalls = 0;
function fakeSummarizeFn(clusterText: string, _budget: number): Promise<string> {
	summarizeCalls++;
	return Promise.resolve(`SUM(${clusterText.length})`);
}

/** 7 leaf cards: alpha pair, beta pair, zeta/delta/epsilon singletons.
 *  Layer 0 → 5 nodes (2 multi + 3 singleton); each node's summary starts
 *  with its topic word, so layer 1 re-embeds to the same 5 directions. */
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

let kb: string;
beforeEach(() => {
	kb = mkdtempSync(join(tmpdir(), "zk-hierbuild-"));
});
afterAll(() => {
	rmSync(kb, { recursive: true, force: true });
});

function opts() {
	return {
		kbDir: kb,
		cards: leafCards(),
		embedFn: fakeEmbedFn,
		summarizeFn: fakeSummarizeFn,
		tokenBudget: 1_000_000,
		maxDepth: 2,
	};
}

const totalEmbeds = () => embedCalls.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildHierarchy", () => {
	test("(a) 3-layer build completes: checkpoints + agg md files on disk", async () => {
		const r = await buildHierarchy(opts());
		expect(r.layers).toBe(3); // depth cap 0,1,2
		expect(r.nodes).toHaveLength(15); // 5 nodes × 3 layers
		expect(r.resumed).toBe(false);
		expect(r.skipped).toBeUndefined();
		for (const l of [0, 1, 2]) {
			expect(existsSync(join(kb, `hierarchy-layer-${l}.json`))).toBe(true);
		}
		const mds = readdirSync(kb).filter((f) => f.endsWith(".md")).sort();
		expect(mds.length).toBe(r.nodes.length); // every node materialized
		expect(mds).toContain("agg-L0-0.md");
		expect(mds).toContain("agg-L2-0.md");
	});

	test("(b) second call resumes: layers skipped, embed calls < first run", async () => {
		embedCalls.length = 0;
		await buildHierarchy(opts());
		const first = totalEmbeds();
		expect(first).toBeGreaterThan(0);

		embedCalls.length = 0;
		const r2 = await buildHierarchy(opts());
		const second = totalEmbeds();
		expect(r2.resumed).toBe(true);
		expect(second).toBe(0); // every layer came from a checkpoint
		expect(second).toBeLessThan(first);
		expect(r2.nodes).toHaveLength(15); // same tree, replayed from disk
		expect(r2.layers).toBe(3);
	});

	test("(c) empty entities → skipped 'no-entities'", async () => {
		const r = await buildHierarchy({
			...opts(),
			cards: [{ id: "c1", text: "alpha text", entities: [] }],
		});
		expect(r.skipped).toBe("no-entities");
		expect(r.layers).toBe(0);
		expect(r.nodes).toEqual([]);
		expect(readdirSync(kb).filter((f) => f.endsWith(".md"))).toEqual([]);
	});

	test("(d) huge tokenBudget → llmCalls === 0 through the orchestration", async () => {
		summarizeCalls = 0;
		const r = await buildHierarchy({ ...opts(), tokenBudget: 1e9 });
		expect(r.layers).toBe(3); // the loop still ran to the depth cap
		expect(r.llmCalls).toBe(0);
		expect(summarizeCalls).toBe(0);
	});

	test("(e) no cards → loader reads kbDir md files, skips agg-L*-* MOCs", async () => {
		writeFileSync(
			join(kb, "card-config.md"),
			[
				"---",
				"id: card-config",
				"entities:",
				"  - config",
				"  - tooling",
				"sources:",
				"  - h-config",
				"---",
				"alpha config body text with some length to cluster",
			].join("\n"),
		);
		// no frontmatter id → falls back to the filename stem
		writeFileSync(
			join(kb, "card-tooling.md"),
			[
				"---",
				"entities:",
				"  - tooling",
				"  - setup",
				"---",
				"beta tooling body text with some length to cluster",
			].join("\n"),
		);
		// {type, name}-style entity entries → names extracted
		writeFileSync(
			join(kb, "card-entities.md"),
			[
				"---",
				"id: card-entities",
				"entities:",
				"  - type: topic",
				"    name: config",
				"  - type: tool",
				"    name: editor",
				"---",
				"zeta object-entity body text with some length to cluster",
			].join("\n"),
		);
		// pre-existing agg MOC — must NOT be loaded as a card
		writeFileSync(
			join(kb, "agg-L0-0.md"),
			"---\nentities:\n  - ghost\n---\nghost aggregation body\n",
		);

		const r = await buildHierarchy({
			kbDir: kb,
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 1_000_000,
			maxDepth: 2,
		});
		expect(r.nodes.length).toBeGreaterThan(0);
		expect(r.skipped).toBeUndefined(); // 3 loaded cards → real build, no skip
		const loadedIds = new Set(r.nodes.flatMap((n) => n.sources));
		expect(loadedIds).toContain("card-config"); // frontmatter id
		expect(loadedIds).toContain("card-tooling"); // filename-stem fallback id
		expect(loadedIds).toContain("card-entities"); // {type, name} entities parsed
		expect(loadedIds.has("agg-L0-0")).toBe(false); // agg MOC skipped
		expect(r.nodes.some((n) => n.entities.includes("ghost"))).toBe(false);
	});
});
