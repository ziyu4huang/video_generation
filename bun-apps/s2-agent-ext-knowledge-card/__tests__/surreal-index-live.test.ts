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
import { rebuildCardIndex, indexStatus, makeContextClient } from "../src/surreal-index.ts";
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
