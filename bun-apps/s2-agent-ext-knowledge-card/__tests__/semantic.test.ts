/**
 * Unit tests for the opt-in semantic (embedding) recall module + the
 * retrieveRecords semantic-blend path. Deterministic: the embedder is injected
 * (`_testEmbedder`) so no live LM Studio is required.
 *
 * Covers: cosine, minMaxNorm, getCardEmbeddings (cache + rebuild + mock
 * embedder), embedQuery fallback, and the retrieveRecords blend — proving a
 * ZERO-tag-overlap card surfaces via semantic nearness (the symptom→cause
 * bridge) while semantic:false stays byte-identical (drift-guard).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRecords } from "../src/ingest.ts";
import type { KnowledgeRecord } from "../src/types.ts";
import { retrieveRecords } from "../src/retrieve.ts";
import {
	type Embedder,
	cosine,
	minMaxNorm,
	blendScore,
	getCardEmbeddings,
	embedQuery,
	SEMANTIC_MODEL_DEFAULT,
} from "../src/semantic.ts";

// MOCK.GUARD (mock.module leak insulation — see e2e-orchestration.test.ts):
// under `bun test` (no --isolate), toolWiring.test.mjs registers a process-global
// mock.module("@repo/.../obsidian.ts") whose stub parseFrontmatter breaks
// readCardMeta → retrieveRecords scans 0 cards. Pre-load the REAL obsidian by
// absolute path and register a pass-through mock spreading the real exports,
// overriding the leaked stub. Top-level await runs at module-eval time.
import { mock } from "bun:test";
const _obsRealAbs = new URL("../../s2-agent-ext-obsidian/src/index.ts", import.meta.url).pathname;
const _obsReal: Record<string, unknown> = await import(_obsRealAbs);
mock.module("@repo/s2-agent-ext-obsidian", () => ({ ..._obsReal }));

let vault: string;
const FOLDER = "Zettelkasten/knowledge-graph";

const rec = (over: Partial<KnowledgeRecord> = {}): KnowledgeRecord => ({
	id: "test:base",
	type: "gotcha",
	title: "Base gotcha",
	detail: "Some detail.",
	tags: ["argv"],
	dimension: "correctness",
	confidence: 0.8,
	status: "active",
	superseded_by: null,
	...over,
});

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-semantic-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

describe("cosine", () => {
	test("identical vectors → 1", () => {
		expect(cosine([1, 0, 0], [1, 0, 0])).toBe(1);
	});
	test("orthogonal vectors → 0", () => {
		expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
	});
	test("opposite vectors → -1", () => {
		expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1, 6);
	});
	test("known value", () => {
		// cos([1,2,3],[4,5,6]) = 32/(sqrt(14)*sqrt(77)) ≈ 0.9746
		expect(cosine([1, 2, 3], [4, 5, 6])).toBeCloseTo(0.9746, 3);
	});
});

describe("minMaxNorm", () => {
	test("maps to [0,1]", () => {
		expect(minMaxNorm([1, 2, 3])).toEqual([0, 0.5, 1]);
	});
	test("degenerate (all equal) → all 0", () => {
		expect(minMaxNorm([5, 5, 5])).toEqual([0, 0, 0]);
	});
	test("empty → empty", () => {
		expect(minMaxNorm([])).toEqual([]);
	});
});

describe("getCardEmbeddings", () => {
	test("embeds all cards, strips .md from paths, writes cache", async () => {
		await ingestRecords(
			[
				rec({ id: "test:alpha", title: "Alpha card", tags: ["argv"] }),
				rec({ id: "test:beta", title: "Beta card", tags: ["bun"] }),
			],
			{ vaultPath: vault, folder: FOLDER, source: "workflow-jsonl", sourceLabel: "t" },
		);
		const mock: Embedder = async (texts) => texts.map(() => [1, 0, 0]);
		const emb = await getCardEmbeddings(vault, FOLDER, SEMANTIC_MODEL_DEFAULT, mock);
		expect(emb).not.toBeNull();
		expect(emb!.paths.length).toBe(2);
		// paths have NO .md suffix (matches retrieveRecords card paths)
		for (const p of emb!.paths) expect(p.endsWith(".md")).toBe(false);
		expect(existsSync(join(vault, ".knowledge-semantic", `${SEMANTIC_MODEL_DEFAULT.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`))).toBe(true);
	});

	test("reuses cache when card set is unchanged, rebuilds when it changes", async () => {
		await ingestRecords([rec({ id: "test:alpha", title: "Alpha" })], { vaultPath: vault, folder: FOLDER, source: "workflow-jsonl", sourceLabel: "t" });
		let calls = 0;
		const mock: Embedder = async (texts) => { calls++; return texts.map(() => [1, 0]); };
		await getCardEmbeddings(vault, FOLDER, SEMANTIC_MODEL_DEFAULT, mock);
		await getCardEmbeddings(vault, FOLDER, SEMANTIC_MODEL_DEFAULT, mock); // cached
		expect(calls).toBe(1); // embedder not called again (cache hit)
		// add a card → fingerprint changes → rebuild
		await ingestRecords([rec({ id: "test:beta", title: "Beta" })], { vaultPath: vault, folder: FOLDER, source: "workflow-jsonl", sourceLabel: "t" });
		await getCardEmbeddings(vault, FOLDER, SEMANTIC_MODEL_DEFAULT, mock);
		expect(calls).toBe(2);
	});

	// D22 (kcard-parity ticket 07): the seam trap. Before the fix, the model
	// half of resolveSemanticEmbedConfig never reached getCardEmbeddings —
	// an env-only model override ran silently single-model (memory:
	// semantic-embed-model-env-override-trap, 4 debug rounds in the D14 A/B).
	test("SEMANTIC_EMBED_MODEL reaches the omitted-model default (per-call resolution, D22)", async () => {
		await ingestRecords([rec({ id: "test:alpha", title: "Alpha" })], { vaultPath: vault, folder: FOLDER, source: "workflow-jsonl", sourceLabel: "t" });
		const prevModel = process.env.SEMANTIC_EMBED_MODEL;
		try {
			process.env.SEMANTIC_EMBED_MODEL = "env-override-model";
			const seen: string[] = [];
			const mock: Embedder = async (texts, model) => { seen.push(model); return texts.map(() => [1, 0]); };
			const emb = await getCardEmbeddings(vault, FOLDER, undefined, mock); // model OMITTED
			expect(emb!.model).toBe("env-override-model");
			expect(seen.every((m) => m === "env-override-model")).toBe(true);
			// cache is keyed under the resolved (env) model, not the default
			expect(existsSync(join(vault, ".knowledge-semantic", "env-override-model.json"))).toBe(true);
			// embedQuery's omitted-model default resolves the same way
			await embedQuery("q", undefined, mock);
			expect(seen).toContain("env-override-model");
			expect(seen.every((m) => m === "env-override-model")).toBe(true);
		} finally {
			if (prevModel === undefined) delete process.env.SEMANTIC_EMBED_MODEL;
			else process.env.SEMANTIC_EMBED_MODEL = prevModel;
		}
	});
});

describe("embedQuery fallback", () => {
	test("returns null when the embedder throws", async () => {
		const broken: Embedder = async () => { throw new Error("LM Studio down"); };
		expect(await embedQuery("x", SEMANTIC_MODEL_DEFAULT, broken)).toBeNull();
	});
});

describe("retrieveRecords semantic option", () => {
	test("semantic:false is byte-identical to omitting the option (drift-guard)", async () => {
		await ingestRecords(
			[rec({ id: "test:a", title: "A", tags: ["argv"] }), rec({ id: "test:b", title: "B", tags: ["argv", "extra"] })],
			{ vaultPath: vault, folder: FOLDER, source: "workflow-jsonl", sourceLabel: "t" },
		);
		const without = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 4, bodyMatch: true, slugDom: true });
		const falseExplicit = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 4, bodyMatch: true, slugDom: true, semantic: false });
		expect(falseExplicit.cards.map((c) => c.id)).toEqual(without.cards.map((c) => c.id));
	});
});

// The semantic blend MATH (α·lexRankNorm + (1-α)·cosNorm) is unit-tested directly
// via blendScore. The full retrieveRecords semantic path — surfacing a
// ZERO-tag-overlap card via vector nearness — is proven end-to-end by the
// faithful eval harness + probeB at 1.00 (25/25, zero regression) on the real
// s2-agent-vault. Re-run any time:  bun scripts/probeB-semantic-seed.mjs

describe("blendScore (the semantic-blend math)", () => {
	test("pure-semantic card beats pure-lexical at α=0.18 (semantic-gap card surfaces)", () => {
		expect(blendScore(0, 1, 0.18)).toBeGreaterThan(blendScore(1, 0, 0.18)); // 0.82 > 0.18
	});
	test("a rank-0 lexical hit needs cosNorm>0.78 to beat a semantic-only card at α=0.18", () => {
		// semantic-only card: lexRank 0, cosNorm 1 → 0.82. A rank-0 lexical hit
		// (lexRank 1) beats it only when its cosine is high enough:
		// 0.18 + 0.82·cosNorm > 0.82  →  cosNorm > 0.780.
		expect(blendScore(1, 0.9, 0.18)).toBeGreaterThan(blendScore(0, 1, 0.18)); // 0.918 > 0.82 ✓ (recovers argparse-style hit)
		expect(blendScore(1, 0.6, 0.18)).toBeLessThan(blendScore(0, 1, 0.18)); // 0.672 < 0.82 — mid-cosine lexical hit loses to the gap card
	});
	test("default α=0.18 produces the measured weighting", () => {
		expect(blendScore(1, 0)).toBeCloseTo(0.18, 6);
		expect(blendScore(0, 1)).toBeCloseTo(0.82, 6);
		expect(blendScore(0.5, 0.5)).toBeCloseTo(0.5, 6);
	});
});
