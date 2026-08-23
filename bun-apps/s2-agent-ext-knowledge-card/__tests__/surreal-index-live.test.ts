/**
 * LIVE contract tests for the kcard SurrealDB index + hierarchical retrieval
 * (kcard-parity ticket 07) — run against the REAL local SurrealDB service
 * (127.0.0.1:8000, SURREAL_DEFAULTS), skipped when it is down (hermes
 * tests/store/surreal/_helpers pattern). Each test gets a THROWAWAY
 * namespace+db so concurrent runs never collide; the namespace is removed at
 * the end. Embedder = deterministic hashing (offline, no LM Studio).
 *
 * Covers what the offline tests cannot: the D13/D21 shadow-rebuild swap
 * (batches land in card_shadow, swap recreates card + HNSW/FTS indexes),
 * the KNN seed lane (`vec <|k,ef|> $qv` + cosine projection), the FTS lane
 * (per-token `@@` on title/summary), parent expansion, and the D18 type
 * filter — end to end.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurrealClient, SURREAL_DEFAULTS } from "@repo/s2-agent-core-interface";
import { rebuildCardIndex, indexStatus, makeContextClient, logUsage, usageStats } from "../src/surreal-index.ts";
import { retrieveRecords } from "../src/retrieve.ts";
import { hierarchicalRetrieve } from "../src/hierarchical-retrieval.ts";
import type { Embedder } from "../src/semantic.ts";

// MOCK.GUARD (see semantic.test.ts): real obsidian pass-through.
const _obsRealAbs = new URL("../../s2-agent-ext-obsidian/src/index.ts", import.meta.url).pathname;
const _obsReal: Record<string, unknown> = await import(_obsRealAbs);
mock.module("@repo/s2-agent-ext-obsidian", () => ({ ..._obsReal }));

async function isSurrealUp(endpoint = SURREAL_DEFAULTS.endpoint): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 1500);
		const res = await fetch(`${endpoint}/health`, { signal: ctrl.signal });
		clearTimeout(t);
		return res.ok || res.status === 200;
	} catch {
		return false;
	}
}

const UP = await isSurrealUp();
const localDescribe = (name: string, body: () => void) =>
	(UP ? describe : (describe.skip as typeof describe))(name, body);

/** Deterministic hashing embedder (recall-audit's makeTestEmbedder shape). */
function hashEmbedder(dim = 32): Embedder {
	return async (texts) =>
		texts.map((t) => {
			const v = new Array<number>(dim).fill(0);
			for (const tok of t.toLowerCase().split(/[^a-z0-9]+/g)) {
				if (!tok) continue;
				let h = 0;
				for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
				v[Math.abs(h) % dim] += 1;
			}
			const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
			return v.map((x) => x / norm);
		});
}

let vault: string;
let ns: string;
let client: SurrealClient;
let nonce = 0;
const FOLDER = "Zettelkasten/knowledge-graph";

function leaf(name: string, title: string, body: string, fm: Record<string, string | number> = {}): void {
	writeFileSync(
		join(vault, FOLDER, `${name}.md`),
		["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), "---", "", `# ${title}`, "", body, ""].join("\n"),
		"utf8",
	);
}

function agg(name: string, children: string[], fm: Record<string, string | number> = {}): void {
	writeFileSync(
		join(vault, FOLDER, `${name}.md`),
		[
			"---",
			`id: "agg:${fm.layer ?? 0}:0"`,
			'created: "auto"',
			"tags: [zettel, derived-aggregation]",
			"kind: derived-aggregation",
			`summary: "aggregate about ${fm.topic ?? name}"`,
			`parent: ${fm.parent ?? "null"}`,
			"entities: [e1]",
			"sources: [s1]",
			`layer: ${fm.layer ?? 0}`,
			"clusterSize: 2",
			"generated: true",
			"---",
			"",
			`# ${name}`,
			"",
			"## 摘要",
			"",
			`summary text ${fm.topic ?? name}`,
			"",
			"## 子節點",
			"",
			...children.map((c) => `- [[${c}]]`),
			"",
		].join("\n"),
		"utf8",
	);
}

localDescribe("kcard SurrealDB index (live)", () => {
	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kcard-surreal-live-"));
		mkdirSync(join(vault, FOLDER), { recursive: true });
		nonce += 1;
		ns = `kcard_test_${process.pid}_${nonce}`;
		client = makeContextClient({ namespace: ns, database: "context_db" });
	});
	afterEach(async () => {
		rmSync(vault, { recursive: true, force: true });
		try {
			await client.query(`REMOVE NAMESPACE ${client.namespace};`);
		} catch {
			// already gone
		}
	});

	test("rebuild → shadow swap lands rows + indexes; fingerprint gates a no-op rerun", async () => {
		leaf("leaf-a", "quantized lora noise", "body about quantization noise in lora adapters");
		leaf("leaf-b", "face swap pipeline", "body about face swap compositing");
		agg("agg-L0-0", ["leaf-a"], { layer: 0, topic: "quantization", parent: '"agg:1:0"' });
		agg("agg-L1-0", ["agg-L0-0"], { layer: 1, topic: "mlxl pipeline", parent: "null" });

		const r1 = await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER, embedder: hashEmbedder() });
		expect(r1.skipped).toBe(false);
		expect(r1.inserted).toBe(4);
		expect(r1.dim).toBe(32);

		const status = await indexStatus(client);
		expect(status.present).toBe(true);
		expect(status.cardCount).toBe(4);
		expect(status.fingerprint).toBe(r1.fingerprint);

		// fingerprint rerun → no-op skip (live table untouched)
		const r2 = await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER, embedder: hashEmbedder() });
		expect(r2.skipped).toBe(true);
	});

	test("hierarchicalRetrieve: semantic seed lane + parent expansion + D18 type filter", async () => {
		leaf("leaf-q", "quantized lora noise", "body about quantization noise in lora adapters", { type: "gotcha" });
		leaf("leaf-f", "swap compositing face", "body about face swap compositing", { type: "lever" });
		agg("agg-L0-0", ["leaf-q"], { layer: 0, topic: "quantization", parent: '"agg:1:0"' });
		agg("agg-L1-0", ["agg-L0-0"], { layer: 1, topic: "quantization family", parent: "null" });

		await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER, embedder: hashEmbedder() });

		// The query's words match leaf-q's TITLE/body vocabulary — the hashing
		// embedder puts it near the query, and the FTS lane matches "lora".
		const res = await hierarchicalRetrieve(client, {
			query: "quantization noise lora",
			topK: 5,
			embedder: hashEmbedder(),
			includeTrace: true,
		});
		expect(res.ok).toBe(true);
		expect(res.cards.length).toBeGreaterThan(0);
		expect(res.cards.map((c) => c.stem)).toContain("leaf-q");
		expect(res.trace!.semanticLane).toBe(true);

		// Type filter (D18): only kind === "lever" survives.
		const typed = await hierarchicalRetrieve(client, {
			query: "quantization noise lora",
			topK: 5,
			type: "lever",
			embedder: hashEmbedder(),
		});
		expect(typed.ok).toBe(true);
		expect(typed.cards.length).toBeGreaterThan(0);
		expect(typed.cards.every((c) => c.kind === "lever")).toBe(true);

		// Type filter with NO matching kind → empty, still ok.
		const none = await hierarchicalRetrieve(client, {
			query: "quantization noise lora",
			topK: 5,
			type: "no-such-kind",
			embedder: hashEmbedder(),
		});
		expect(none.ok).toBe(true);
		expect(none.cards).toEqual([]);
	});

	test("propagation reaches through UNSEEDED intermediate aggs (reviewer F1 pin)", async () => {
		// Only the L2 root matches the query ("uniquerootword" appears in its
		// title/summary alone); L1/L0/leaf never seed. The leaf must still
		// surface — via three levels of γ-decayed propagation, viaTree=true.
		leaf("leaf-deep", "unrelated vocabulary entirely", "body with no query overlap at all");
		agg("agg-L0-0", ["leaf-deep"], { layer: 0, topic: "unrelated subtopic", parent: '"agg:1:0"' });
		agg("agg-L1-0", ["agg-L0-0"], { layer: 1, topic: "unrelated mid", parent: '"agg:2:0"' });
		agg("agg-L2-0", ["agg-L1-0"], { layer: 2, topic: "uniquerootword family root", parent: "null" });
		await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER, embedder: hashEmbedder() });

		const res = await hierarchicalRetrieve(client, {
			query: "uniquerootword family root",
			topK: 5,
			seedTopN: 1, // KNN returns ONLY the nearest card (the L2 root)
			embedder: hashEmbedder(),
			includeTrace: true,
		});
		expect(res.ok).toBe(true);
		const deep = res.cards.find((c) => c.stem === "leaf-deep");
		expect(deep).toBeDefined();
		expect(deep!.viaTree).toBe(true);
		expect(res.trace!.sweeps).toBeGreaterThanOrEqual(3);
	});

	test("embed-model change forces a rebuild (reviewer F2 pin — D10 model-swap A/B)", async () => {
		leaf("leaf-a", "quantized lora noise", "body about quantization noise in lora adapters");
		agg("agg-L0-0", ["leaf-a"], { layer: 0, topic: "quantization" });
		const r1 = await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER, model: "model-a", embedder: hashEmbedder() });
		expect(r1.skipped).toBe(false);
		const s1 = await indexStatus(client);
		expect(s1.embedModel).toBe("model-a");
		// Same content, DIFFERENT model → must NOT skip (old code skipped and
		// silently kept model-a vectors).
		const r2 = await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER, model: "model-b", embedder: hashEmbedder() });
		expect(r2.skipped).toBe(false);
		const s2 = await indexStatus(client);
		expect(s2.embedModel).toBe("model-b");
		// Same content + same model → skip.
		const r3 = await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER, model: "model-b", embedder: hashEmbedder() });
		expect(r3.skipped).toBe(true);
	});

	test("hierarchicalRetrieve: FTS-only when the embedder is down (lexical lane holds)", async () => {
		leaf("leaf-x", "rareword xyzzy title", "body mentioning rareword");
		agg("agg-L0-0", ["leaf-x"], { layer: 0, topic: "rareword cluster" });
		await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER, embedder: hashEmbedder() });
		const broken: Embedder = async () => {
			throw new Error("embedder down");
		};
		const res = await hierarchicalRetrieve(client, {
			query: "rareword",
			topK: 3,
			embedder: broken,
			includeTrace: true,
		});
		expect(res.ok).toBe(true);
		expect(res.trace!.semanticLane).toBe(false);
		expect(res.cards.map((c) => c.stem)).toContain("leaf-x");
	});
});

localDescribe("kcard usage ledger + hotness fold (ticket 08, live)", () => {
	// Shares the module-level vault/ns/client (the helper fixtures above) —
	// each test gets a fresh throwaway ns from the beforeEach below.
	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kcard-hot-live-"));
		mkdirSync(join(vault, FOLDER), { recursive: true });
		nonce += 1;
		ns = `kcard_hot_${process.pid}_${nonce}`;
		client = makeContextClient({ namespace: ns, database: "context_db" });
	});
	afterEach(async () => {
		rmSync(vault, { recursive: true, force: true });
		try {
			await client.query(`REMOVE NAMESPACE ${client.namespace};`);
		} catch {
			// already gone
		}
	});

	test("logUsage → usageStats round trip; live ledges feed the D37 fold through retrieveRecords", async () => {
		// NOTE the fm: the D27 hier lane HYDRATES through the flat md-read path,
		// which needs a non-empty (id + tags) frontmatter — the raw-body
		// `leaf()` fixtures below would hydrate to nothing.
		leaf("leaf-a", "quantized lora noise", "body about quantization noise in lora adapters", { id: "leaf-a", tags: "[quantization]" });
		leaf("leaf-b", "face swap pipeline", "body about face swap compositing from source video", { id: "leaf-b", tags: "[face]" });
		await rebuildCardIndex({ client, vaultPath: vault, folder: FOLDER, embedder: hashEmbedder() });

		// Writer round trip (the same rows recordUsage appends in production).
		const ts = Date.now() - 86_400_000; // 1d ago — deterministic-ish
		await logUsage(client, ["leaf-a", "leaf-a", "leaf-b"], ts);
		const stats = await usageStats(client);
		expect(stats.get("leaf-a")).toEqual({ count: 2, lastUseMs: ts });
		expect(stats.get("leaf-b")).toEqual({ count: 1, lastUseMs: ts });

		// End-to-end: retrieveRecords with the LIVE hierarchy + the LIVE ledger
		// aggregates injected through the test seam (the throwaway-ns client).
		const r = await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: ["quantization"],
			queryText: "quantized lora noise",
			topK: 4,
			semantic: true,
			_testEmbedder: hashEmbedder(),
			_hierClient: client,
			_usageStats: stats,
			includeTrace: true,
		});
		expect(r.trace?.hierUsed).toBe(true);
		expect(r.trace?.hotnessUsed).toBe(true);
		// leaf-a accessed twice (freq 3/4) + anchor = the freshly-written mtime
		// (D39 max(mtime, last_use) → decay ≈ 1) → h ≈ 0.75 — boosted; leaf-b
		// once → freq 2/3 — lower. Provenance proves the fold.
		const a = r.trace?.cards.find((c) => c.id === "leaf-a");
		const b = r.trace?.cards.find((c) => c.id === "leaf-b");
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a!.hotness).toBeGreaterThan(0.7);
		expect(a!.hotness).toBeCloseTo(0.75, 1);
		expect(b!.hotness).toBeCloseTo(2 / 3, 1);
		expect(b!.hotness).toBeLessThan(a!.hotness!);
		// D37 bound (unit-pinned in hotness.test.ts): every folded score stays
		// within ±10% of its pre-fold value — re-assert via h: factor = 1+β(2h−1).
		expect(a!.score).toBeGreaterThan(0);
		const factor = 1 + 0.1 * (2 * a!.hotness! - 1);
		expect(factor).toBeGreaterThanOrEqual(0.9);
		expect(factor).toBeLessThanOrEqual(1.1);
	});
});
