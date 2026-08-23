/**
 * retrieve-hotness.test.ts — ticket 08 D37/D38 integration: the bounded fold
 * INSIDE retrieveRecords (lexical + semantic lanes), hermetic (injected
 * `_usageStats`, no Surreal, no network).
 *
 * Pins: the D40 default-on/opt-out env contract, the fold's ±β band vs a
 * baseline run, trace provenance (hotnessUsed + per-card hotness), and the
 * semantic lane folding AFTER its blend (never reshaping its pool).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRecords } from "../src/ingest.ts";
import { retrieveRecords } from "../src/retrieve.ts";
import type { KnowledgeRecord } from "../src/types.ts";
import type { Embedder } from "../src/semantic.ts";
import type { UsageStats } from "../src/hotness.ts";

let vault: string;
const FOLDER = "Zettelkasten/knowledge-graph";
const MOC = "Tags/Knowledge Graph.md";
const NOW = Date.now();

function rec(over: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
	return {
		id: "t:base",
		type: "gotcha",
		title: "Base gotcha",
		detail: "Some detail about the gotcha.",
		tags: ["argv"],
		dimension: "correctness",
		confidence: 0.8,
		status: "active",
		superseded_by: null,
		...over,
	};
}

beforeEach(async () => {
	vault = mkdtempSync(join(tmpdir(), "kcard-hotness-"));
	await ingestRecords(
		[
			rec({ id: "t:hot", title: "Hot card", detail: "plain" }),
			rec({ id: "t:cold", title: "Cold card", detail: "plain" }),
		],
		{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "test", folder: FOLDER, mocPath: MOC },
	);
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

// NOTE: usage keys are md FILENAME STEMS (D9 record key) — ingest slugifies
// the id (`t:hot` → `t-hot.md`), and the fold/writer both pop the filename
// stem off the card `path`.
const hotStats: UsageStats = new Map([
	["t-hot", { count: 60, lastUseMs: NOW - 1 }], // h ≈ 0.98·0.999 ≈ 0.97 → factor ≈ 1.095
]);

describe("retrieveRecords + D37 hotness fold (lexical lane)", () => {
	test("bounded re-rank: a hot card overtakes an equal-score cold card", async () => {
		const folded = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 10,
			hotness: true, _usageStats: hotStats, includeTrace: true,
		});
		// Both cards share the one query tag → base _score tie → fold decides.
		expect(folded.count).toBe(2);
		// The served rank order: hot first.
		expect(folded.cards[0]!.id).toBe("t:hot");
		expect(folded.trace!.hotnessUsed).toBe(true);
		// Provenance: h for t:hot is high; t:cold has no usage + fresh mtime → neutral.
		const tr = folded.trace!.cards.find((c) => c.id === "t:hot")!;
		expect(tr.hotness).toBeGreaterThan(0.9);
		expect(tr.hotness).toBeLessThanOrEqual(1);
		const coldTr = folded.trace!.cards.find((c) => c.id === "t:cold")!;
		expect(coldTr.hotness!).toBeGreaterThanOrEqual(0.499);
		expect(coldTr.hotness!).toBeLessThanOrEqual(0.501);
	});

	test("fold stays within the ±10% band vs the baseline run", async () => {
		const base = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 10,
			hotness: false, includeTrace: true,
		});
		const folded = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 10,
			hotness: true, _usageStats: hotStats, includeTrace: true,
		});
		expect(base.trace!.hotnessUsed).toBe(false);
		const baseScore = base.trace!.cards.find((c) => c.id === "t:hot")!.score;
		// Sanity: no-fold baseline is the count-lane score (shared=1, no callout).
		expect(baseScore).toBe(1);
		const foldedScore = folded.trace!.cards.find((c) => c.id === "t:hot")!.score;
		// D37: final ∈ [0.9·score, 1.1·score].
		expect(foldedScore / baseScore).toBeGreaterThanOrEqual(0.9);
		expect(foldedScore / baseScore).toBeLessThanOrEqual(1.1);
		expect(foldedScore / baseScore).toBeGreaterThan(1.05); // the boost actually applied
	});
});

describe("D40 default-on contract (env-gated, mirrors D36)", () => {
	test("default (env absent) = hotness ON; KCARD_HOTNESS_DEFAULT=0 = OFF/identity", async () => {
		const prev = process.env.KCARD_HOTNESS_DEFAULT;
		delete process.env.KCARD_HOTNESS_DEFAULT;
		try {
			// Default-on, WITH the same injected stats → hot first.
			const def = await retrieveRecords({
				vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 10,
				_usageStats: hotStats, includeTrace: true,
			});
			expect(def.cards[0]!.id).toBe("t:hot");
			expect(def.trace!.hotnessUsed).toBe(true);
			// Escape: KCARD_HOTNESS_DEFAULT=0 → no fold, id tie-break order back
			// (t:cold vs t:hot — id asc → t:cold wins the exact tie).
			process.env.KCARD_HOTNESS_DEFAULT = "0";
			const off = await retrieveRecords({
				vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 10,
				_usageStats: hotStats, includeTrace: true,
			});
			expect(off.trace!.hotnessUsed).toBe(false);
			expect(off.trace!.cards[0]!.score).toBe(1);
			const ids = off.cards.map((c) => c.id).sort();
			expect(ids).toEqual(["t:cold", "t:hot"]);
		} finally {
			if (prev === undefined) delete process.env.KCARD_HOTNESS_DEFAULT;
			else process.env.KCARD_HOTNESS_DEFAULT = prev;
		}
	});
});

describe("retrieveRecords + D37 hotness fold (semantic lane, post-blend)", () => {
	test("hotnessUsed populated; the fold never reshapes the blend pool", async () => {
		// Reuse the retrieve.test.ts semantic fixture: t:sem is zero-tag-overlap,
		// surfaces via vector nearness ONLY (semantic-top); the blend ranks it
		// ABOVE the lexical-only card. Hotness on t:lex must NOT move the
		// semantic-only card (its score gap is beyond the ±10% band) — the fold
		// is a bounded post-blend re-rank.
		await ingestRecords(
			[rec({ id: "t:sem", title: "Semantic zzz card", tags: ["zzz"], detail: "plain" })],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "test", folder: FOLDER, mocPath: MOC },
		);
		const emb: Embedder = async (texts) => texts.map((t) => (/zzz/i.test(t) ? [1, 0] : [0, 1]));
		const r = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], queryText: "zzz query",
			topK: 4, semantic: true, _testEmbedder: emb,
			hotness: true, _usageStats: hotStats, includeTrace: true,
		});
		expect(r.trace).toBeDefined();
		expect(r.trace!.hotnessUsed).toBe(true);
		const sem = r.trace!.cards.find((c) => c.id === "t:sem")!;
		const lex = r.trace!.cards.find((c) => c.id === "t:hot")!;
		// Pool/blend semantics unchanged: semantic-only card still on top.
		expect(r.trace!.cards[0]!.id).toBe("t:sem");
		// Fold provenance on both lane cards.
		expect(lex.hotness).toBeGreaterThan(0.9); // folded up
		expect(sem.hotness).toBeGreaterThan(0.499);
		expect(sem.hotness).toBeLessThan(0.501); // neutral (no usage, fresh mtime)
	});
});
