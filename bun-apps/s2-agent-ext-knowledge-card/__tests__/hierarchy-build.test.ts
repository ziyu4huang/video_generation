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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// (f) checkpoint version gate (ticket 06) — stale formats rebuild, not resume
// ---------------------------------------------------------------------------

describe("buildHierarchy checkpoint version gate", () => {
	let staleKb: string;
	beforeEach(() => {
		staleKb = mkdtempSync(join(tmpdir(), "zk-hierstale-"));
	});
	afterAll(() => {
		rmSync(staleKb, { recursive: true, force: true });
	});

	test("a v-less (v1) checkpoint on disk is IGNORED — the layer rebuilds", async () => {
		// Simulate an in-flight checkpoint from BEFORE the ticket-06 format
		// bump: same field shape, no `v` stamp.
		writeFileSync(
			join(staleKb, "hierarchy-layer-0.json"),
			JSON.stringify({ nodes: [], llmCalls: 0, done: true }),
		);
		const r = await buildHierarchy({
			kbDir: staleKb,
			cards: [
				{ id: "c1", text: "alpha body text", entities: ["a"] },
				{ id: "c2", text: "alpha other text", entities: ["a"] },
			],
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 1_000_000,
		});
		expect(r.staleCheckpoints).toBe(1);
		expect(r.resumed).toBe(false); // nothing resumed — the stale layer rebuilt
		expect(r.nodes.length).toBeGreaterThan(0); // a real (rebuilt) tree
		// the rewrite stamped the current version
		const rewritten = JSON.parse(readFileSync(join(staleKb, "hierarchy-layer-0.json"), "utf8"));
		expect(rewritten.v).toBe(2);
	});

	test("a current-version checkpoint still resumes (staleCheckpoints 0)", async () => {
		const r1 = await buildHierarchy({
			kbDir: staleKb,
			cards: [
				{ id: "c1", text: "alpha body text", entities: ["a"] },
				{ id: "c2", text: "alpha other text", entities: ["a"] },
			],
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 1_000_000,
		});
		expect(r1.staleCheckpoints).toBe(0);
		const r2 = await buildHierarchy({
			kbDir: staleKb,
			cards: [
				{ id: "c1", text: "alpha body text", entities: ["a"] },
				{ id: "c2", text: "alpha other text", entities: ["a"] },
			],
			embedFn: fakeEmbedFn,
			summarizeFn: fakeSummarizeFn,
			tokenBudget: 1_000_000,
		});
		expect(r2.resumed).toBe(true);
		expect(r2.staleCheckpoints).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// (g) loader tags fallback (ticket 06) — pre-P8 vault cards carry only tags
// ---------------------------------------------------------------------------

describe("loadKbCards tags fallback", () => {
	test("a tags-only card loads with tags (minus zettel) as entities; entities still win when present", async () => {
		const kb = mkdtempSync(join(tmpdir(), "zk-hiertags-"));
		try {
			writeFileSync(
				join(kb, "card-tags-only.md"),
				["---", "id: card-tags-only", "tags: [zettel, flux2, mechanism]", "---", "alpha body text to cluster"].join("\n"),
			);
			writeFileSync(
				join(kb, "card-typed.md"),
				["---", "id: card-typed", "entities: [topic:mlx]", "tags: [zettel, gui]", "---", "alpha other text to cluster"].join("\n"),
			);
			const r = await buildHierarchy({
				kbDir: kb,
				embedFn: fakeEmbedFn,
				summarizeFn: fakeSummarizeFn,
				tokenBudget: 1_000_000,
			});
			expect(r.skipped).toBeUndefined();
			const byTagEntities = r.nodes.some((n) => n.entities.includes("flux2") && n.entities.includes("mechanism"));
			expect(byTagEntities).toBe(true);
			// the `zettel` structural marker never leaks into an entity union
			expect(r.nodes.some((n) => n.entities.includes("zettel"))).toBe(false);
			// typed entities take precedence over tags for the same card
			expect(r.nodes.some((n) => n.entities.includes("topic:mlx"))).toBe(true);
		} finally {
			rmSync(kb, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// (h) final materialization pass — resumed runs still re-render agg cards
// ---------------------------------------------------------------------------

describe("buildHierarchy final pass", () => {
	test("a fully-resumed run re-writes agg cards when the renderer changed (filename links)", async () => {
		const kb = mkdtempSync(join(tmpdir(), "zk-hierfinal-"));
		try {
			writeFileSync(
				join(kb, "card-titled.md"),
				["---", "id: 202405201000", "entities:", "  - mlx", "---", "alpha body text to cluster"].join("\n"),
			);
			const embed = (texts: string[]) => Promise.resolve(texts.map(() => [1, 0.1]));
			const first = await buildHierarchy({ kbDir: kb, embedFn: embed, tokenBudget: 1_000_000 });
			expect(first.resumed).toBe(false);
			// child link must target the FILE stem, not the numeric id
			const c = readFileSync(join(kb, "agg-L0-0.md"), "utf8");
			expect(c).toContain("[[card-titled]]");
			expect(c).not.toContain("[[202405201000]]");

			// simulate a renderer change: leave a stale (still derived-kind) agg
			// file on disk, then re-run — every layer resumes, but the FINAL
			// pass restores the current rendering. (A NON-derived file here
			// would be REFUSED by the T2 guard — that's its job.)
			writeFileSync(join(kb, "agg-L0-0.md"), "---\nkind: derived-aggregation\n---\nstale rendering\n");
			const second = await buildHierarchy({ kbDir: kb, embedFn: embed, tokenBudget: 1_000_000 });
			expect(second.resumed).toBe(true);
			const c2 = readFileSync(join(kb, "agg-L0-0.md"), "utf8");
			expect(c2).toContain("[[card-titled]]");
		} finally {
			rmSync(kb, { recursive: true, force: true });
		}
	});
});
