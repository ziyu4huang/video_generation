/**
 * lexical-blend.test.ts — retrieval-lift-2 T2/T3.
 *
 * T3: CJK-aware lexical tokenization. The lexical family was ASCII-deaf:
 * inferQueryTags whitespace-splits [a-z0-9-], bodyTokenOverlap strips all
 * non-ASCII — zh questions get ZERO lexical signal (pure-zh queries → []
 * tags → no lexical eligibility at all). Shared bigram tokenization lives
 * in the LEAF module card-format.ts (host-fns ↔ retrieve is an import
 * cycle). English-only inputs must stay byte-identical (no-regression pin).
 *
 * T2: the flat-blend α-cap. blendScore = α·lexRankNorm + (1−α)·cosNorm
 * caps a lexical-#1 target at α + (1−α)·cn — competitors with a
 * cosine-norm gap push it below the topK=10 cut (rank 0) no matter the
 * lexical evidence. The absolute overlap term β·min(ov,3)/3 (mirror of the
 * hier lane's SLUG_BETA stem term, on the ov triple shared+body+slug —
 * flat victims already hold lr=1.0) restores the ordering.
 *
 * Everything offline + deterministic: blend math is pure; the integration
 * tests run retrieveRecords with an injected _testEmbedder on a tmp vault.
 */
import { describe, expect, test, mock } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MOCK.GUARD (same insulation as semantic.test.ts): under plain `bun test`
// a leaked global mock of obsidian's parseFrontmatter breaks readCardMeta.
const _obsRealAbs = new URL("../../s2-agent-ext-obsidian/src/index.ts", import.meta.url).pathname;
const _obsReal: Record<string, unknown> = await import(_obsRealAbs);
mock.module("@repo/s2-agent-ext-obsidian", () => ({ ..._obsReal }));

import { cjkBigrams, distinctiveRelationTokens } from "../src/card-format.ts";
import { blendScore, cardEmbedText, EMBED_TOTAL_CHARS, getCardEmbeddings, type Embedder } from "../src/semantic.ts";
import { inferQueryTags } from "../src/host-fns.ts";
import { retrieveRecords } from "../src/retrieve.ts";
import { ingestRecords } from "../src/ingest.ts";
import type { KnowledgeRecord } from "../src/types.ts";

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

describe("T3 — cjkBigrams (card-format leaf)", () => {
	test("a CJK run yields overlapping bigrams", () => {
		expect(cjkBigrams("軟體供應鏈")).toEqual(["軟體", "體供", "供應", "應鏈"]);
	});
	test("a single-char run stays a single token; ASCII yields none", () => {
		expect(cjkBigrams("測")).toEqual(["測"]);
		expect(cjkBigrams("argparse flags")).toEqual([]);
		expect(cjkBigrams("mixed 測試 text")).toEqual(["測試"]);
	});
});

describe("T3 — inferQueryTags bigram extension", () => {
	test("a pure-zh question yields bigram tags (was: zero tags → no lexical lane)", () => {
		const tags = inferQueryTags("軟體供應鏈安全為什麼日益關鍵");
		expect(tags.length).toBeGreaterThan(0);
		expect(tags).toContain("軟體");
		expect(tags).toContain("供應");
		expect(tags).toContain("應鏈");
	});
	test("mixed query: ASCII tokens first, bigrams appended, deduped, capped", () => {
		const tags = inferQueryTags("在 SWE-bench Verified 上測試什麼");
		expect(tags[0]).toBe("swe-bench");
		expect(tags).toContain("測試");
		// overall cap stays bounded (ASCII ≤10 + bigrams, cap 24)
		const silly = inferQueryTags(`工具${"很長".repeat(40)}`);
		expect(silly.length).toBeLessThanOrEqual(24);
	});
	test("no-regression pin: English-only output is unchanged (3–30 chars, max 10)", () => {
		expect(inferQueryTags("How to configure the Argparse FLAGS quickly?")).toEqual([
			"how",
			"configure",
			"the",
			"argparse",
			"flags",
			"quickly",
		]);
		expect(inferQueryTags("a bb ccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll")).toEqual([
			"ccc",
			"dddd",
			"eeee",
			"ffff",
			"gggg",
			"hhhh",
			"iiii",
			"jjjj",
			"kkkk",
			"llll",
		]);
	});
});

async function seedZh(): Promise<{ vault: string; id: string }> {
	const vault = mkdtempSync(join(tmpdir(), "kcard-zh-"));
	const rec: KnowledgeRecord = {
		id: "test:zh-alpha",
		type: "gotcha",
		title: "中文測試卡",
		detail: "這是一個測試用例的內容描述",
		tags: ["zhtopic"],
		dimension: "correctness",
		confidence: 0.8,
		status: "active",
		superseded_by: null,
	};
	await ingestRecords([rec], { vaultPath: vault, source: "workflow-jsonl", sourceLabel: "t", folder: FOLDER });
	return { vault, id: rec.id };
}

describe("T3 — bodyTokenOverlap bigram matching (integration, offline)", () => {
	test("a zh query bigram matches zh body prose via bodyMatch", async () => {
		const { vault, id } = await seedZh();
		try {
			// Pre-fix: the body tokenizer strips CJK → bodyOv 0 → card ineligible.
			const res = await retrieveRecords({
				vaultPath: vault,
				tags: ["測試"],
				bodyMatch: true,
				topK: 5,
			});
			expect(res.cards.map((c) => c.id)).toContain(id);
		} finally {
			rmSync(vault, { recursive: true, force: true });
		}
	});
});

describe("T2 — blendScore absolute overlap term", () => {
	// The pinned synthetic pool (integration test below): 10 competitors at
	// cn=1.0/ov=1 vs a lexical-#1 target at cn=0.7/ov=3, α=0.18, β=0.2.
	const T = { lr: 1, cn: 0.8, ov: 3 };
	const C = { lr: 2 / 12, cn: 1, ov: 1 }; // the WEAKEST competitor
	test("pre-fix shape: the cap buries the lexical-#1 target below the cut", () => {
		expect(blendScore(T.lr, T.cn, 0.18)).toBeLessThan(blendScore(C.lr, C.cn, 0.18)); // 0.836 < 0.85
	});
	test("post-fix shape: the absolute term flips the ordering", () => {
		expect(blendScore(T.lr, T.cn, 0.18, T.ov, 0.2)).toBeGreaterThan(blendScore(C.lr, C.cn, 0.18, C.ov, 0.2)); // 1.036 > 0.917
	});
	test("β term is additive, capped at min(ov,3)/3, and defaults OFF (β=0)", () => {
		expect(blendScore(0.5, 0.5, 0.18, 3, 0.2)).toBeCloseTo(0.5 + 0.2, 6);
		expect(blendScore(0.5, 0.5, 0.18, 7, 0.2)).toBeCloseTo(0.5 + 0.2, 6); // capped
		expect(blendScore(0.5, 0.5, 0.18, 2, 0.2)).toBeCloseTo(0.5 + (0.2 * 2) / 3, 6);
		expect(blendScore(0.5, 0.5, 0.18, 5)).toBe(blendScore(0.5, 0.5, 0.18)); // β=0 default
	});
});

describe("T2 — the topK-cut rescue (integration, offline)", () => {
	test("a lexical-#1 target with ov=3 below the topK cut pre-fix ranks top-3 post-fix", async () => {
		const vault = mkdtempSync(join(tmpdir(), "kcard-blend-"));
		try {
			const mk = (over: Partial<KnowledgeRecord>): KnowledgeRecord => ({
				id: "test:x",
				type: "gotcha",
				title: "X",
				detail: "detail",
				tags: ["tagx"],
				dimension: "correctness",
				confidence: 0.8,
				status: "active",
				superseded_by: null,
				...over,
			});
			// Target: shared 1 (tag zedtarget) + body carries both query tokens
			// (bodyOv 2) → _score 4, lexical #1, ov = 3.
			const target = mk({
				id: "test:target-alpha",
				title: "Target alpha ZEDTARGETMARK",
				detail: "zedtarget qux rescue prose ZEDTARGETMARK",
				tags: ["zedtarget"],
			});
			// 10 competitors: shared 1 (tag qux), body without query tokens →
			// _score 1, ov = 1, semantic-strong (COMPMARK).
			const competitors = Array.from({ length: 10 }, (_, i) =>
				mk({
					id: `test:comp-${String(i + 1).padStart(2, "0")}`,
					title: `Comp ${i + 1} COMPMARK`,
					detail: `competitor prose number ${i + 1} COMPMARK`,
					tags: ["qux"],
				}),
			);
			// 3 floor cards: same lexical shape, semantic-far (FLOORMARK) — they
			// set the min-max cosine floor so cn_target = 0.7 vs cn_comp = 1.0.
			const floors = Array.from({ length: 3 }, (_, i) =>
				mk({
					id: `test:floor-${i + 1}`,
					title: `Floor ${i + 1} FLOORMARK`,
					detail: `floor prose ${i + 1} FLOORMARK`,
					tags: ["qux"],
				}),
			);
			await ingestRecords([target, ...competitors, ...floors], {
				vaultPath: vault,
				source: "workflow-jsonl",
				sourceLabel: "t",
				folder: FOLDER,
			});
			const vec = (async (texts: string[]) =>
				texts.map((t) => {
					if (t.includes("ZEDTARGETMARK")) return [0.5, 0.866]; // cos .50 → cn .80
					if (t.includes("COMPMARK")) return [0.6, 0.8]; // cos .60
					if (t.includes("FLOORMARK")) return [0.1, 0.995]; // cos .10
					return [1, 0]; // the query "zedtarget qux"
				})) as unknown as Embedder;
			const res = await retrieveRecords({
				vaultPath: vault,
				folder: FOLDER,
				tags: ["zedtarget", "qux"],
				queryText: "zedtarget qux",
				bodyMatch: true,
				slugDom: true,
				semantic: true,
				topK: 10,
				_testEmbedder: vec,
			});
			// Pre-fix the target's blend score 0.18·1 + 0.82·0.8 = 0.836 loses to
			// all ten competitors (≥ 0.18·(2/12) + 0.82·1 = 0.85) → rank 11 →
			// BELOW the topK=10 cut. RED pre-fix: the target is absent entirely.
			const ids = res.cards.map((c) => c.id);
			expect(ids).toContain("test:target-alpha");
			expect(ids.indexOf("test:target-alpha")).toBeLessThan(3);
		} finally {
			rmSync(vault, { recursive: true, force: true });
		}
	});
});

// ─── kcard-hit3-residual T2: the gated 連結-scoped relation term ─────────────
// Relation-intent queries (連結 + 相關/互為/同屬/指向) ask about the card
// graph; their target identity lives in the target's ## 連結 section as an
// ANCHOR phrase, while the template vocabulary (相關/連結/卡片…) matches
// ~1867 link-section bodies and drowns the target in bodyTokenOverlap. The
// lever adds REL_TERM·min(relOv,3)/3 to the lexical score, where relOv =
// |distinctive (template-stripped) query tokens ∩ the card's 連結-section
// tokens| — and counts relOv into _lexOv so the semantic blend's β term
// carries the same evidence. The gate NEVER fires on non-relation queries.

describe("T2(hit3) — gated 連結-scoped relation term (integration, offline)", () => {
	test("an anchored relation query ranks its target #1 over template-noise hubs", async () => {
		const vault = mkdtempSync(join(tmpdir(), "kcard-rel-"));
		try {
			const mk = (over: Partial<KnowledgeRecord>): KnowledgeRecord => ({
				id: "test:x",
				type: "reference",
				title: "X",
				detail: "detail",
				tags: ["tagx"],
				dimension: "correctness",
				confidence: 0.8,
				status: "active",
				superseded_by: null,
				...over,
			});
			// The target: its 連結 section carries the anchor phrase 視覺表徵研究
			// (5 distinctive bigrams); total query-tag bodyOv = 7.
			const target = mk({
				id: "test:rel-target",
				title: "Rel target ZEDTARGETMARK",
				detail: "本卡的核心內容。\n\n## 連結\n- 相關：視覺表徵研究\n",
				tags: ["reltarget"],
			});
			// A template-noise hub: its body packs 9 distinct query-tag bigrams
			// (這張 張卡 卡的 相關 連結 指向 向哪 哪張 卡片) — pre-fix it outranks
			// the target (7). Its 連結 section links an unrelated paper, so its
			// relOv = 0: post-fix the target's saturated anchor term (+6) wins.
			const hub = mk({
				id: "test:rel-hub",
				title: "Rel hub",
				detail: "這張卡的相關連結，指向哪張卡片？\n\n## 連結\n- 相關：Paper - 甲乙丙\n",
				tags: ["relhub"],
			});
			const filler = mk({
				id: "test:rel-filler",
				title: "Rel filler",
				detail: "完全無關的內容。",
				tags: ["relfiller"],
			});
			await ingestRecords([target, hub, filler], {
				vaultPath: vault,
				source: "workflow-jsonl",
				sourceLabel: "t",
				folder: FOLDER,
			});
			const query = "這張卡的「相關」連結指向哪張同為視覺表徵研究的卡片？";
			const res = await retrieveRecords({
				vaultPath: vault,
				folder: FOLDER,
				tags: inferQueryTags(query),
				queryText: query,
				bodyMatch: true,
				topK: 5,
			});
			// RED pre-fix: the hub's template bodyOv (8) beats the target's (7).
			expect(res.cards[0]!.id).toBe("test:rel-target");
		} finally {
			rmSync(vault, { recursive: true, force: true });
		}
	});

	test("a BARE relation query (zero distinctive tokens) never fires the term", async () => {
		const vault = mkdtempSync(join(tmpdir(), "kcard-relbare-"));
		try {
			const mk = (over: Partial<KnowledgeRecord>): KnowledgeRecord => ({
				id: "test:x",
				type: "reference",
				title: "X",
				detail: "detail",
				tags: ["tagx"],
				dimension: "correctness",
				confidence: 0.8,
				status: "active",
				superseded_by: null,
				...over,
			});
			const a = mk({ id: "test:bare-a", title: "Bare A", detail: "內容甲。", tags: ["bara"] });
			const b = mk({ id: "test:bare-b", title: "Bare B", detail: "內容乙。", tags: ["barb"] });
			await ingestRecords([a, b], { vaultPath: vault, source: "workflow-jsonl", sourceLabel: "t", folder: FOLDER });
			const query = "這張卡與哪兩張卡片有「相關」連結？";
			expect(distinctiveRelationTokens(query)).toEqual([]); // classifier contract
			const res = await retrieveRecords({
				vaultPath: vault,
				folder: FOLDER,
				tags: inferQueryTags(query),
				queryText: query,
				bodyMatch: true,
				topK: 5,
			});
			// No card is eligible via the relation term (relOv 0 for all); the
			// result is whatever the untouched lexical lane serves — the assert
			// is that NOTHING crashed and both cards surface via template
			// bodyOv, unchanged ordering by their own ids.
			expect(res.cards.map((c) => c.id).sort()).toEqual(["test:bare-a", "test:bare-b"]);
		} finally {
			rmSync(vault, { recursive: true, force: true });
		}
	});
});

// ─── kcard-hit3-residual V2: 連結 tail in the embed text ─────────────────────
describe("V2 — 連結 anchor tail in cardEmbedText (offline)", () => {
	test("the bounded link-section anchor rides the embed; wiki brackets stripped", () => {
		const raw = [
			"---", "summary: 測試摘要", "---", "# T", "", "## 核心想法", "- 內容主張。", "",
			"## 連結", "- 相關：視覺表徵研究", "- 相關：[[generic-paper-amari]]", "",
		].join("\n");
		const t = cardEmbedText(raw, "T", ["tag"]);
		expect(t).toContain("視覺表徵研究"); // the anchor phrase reaches the vector
		expect(t).toContain("generic-paper-amari"); // wiki-link → plain text
		expect(t).not.toContain("[["); // brackets never embed
		expect(t.length).toBeLessThanOrEqual(EMBED_TOTAL_CHARS);
	});

	test("a v1 cache (no textVersion) rebuilds instead of serving stale vectors", async () => {
		const vault = mkdtempSync(join(tmpdir(), "kcard-v2cache-"));
		try {
			await ingestRecords(
				[rec({ id: "test:v2a", title: "V2 alpha", tags: ["v2tag"] })],
				{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "t", folder: FOLDER },
			);
			let calls = 0;
			const counting = (async (texts: string[]) => {
				calls += texts.length;
				return texts.map(() => [1, 0, 0]);
			}) as unknown as Embedder;
			await getCardEmbeddings(vault, FOLDER, undefined, counting);
			const callsFirst = calls;
			expect(callsFirst).toBeGreaterThan(0);
			// Strip textVersion from the cache → a v1-era cache. Same fingerprint,
			// same card count — ONLY the version gate can trigger the rebuild.
			const cachePath = join(vault, ".knowledge-semantic", "text-embedding-bge-m3.json");
			const cache = JSON.parse(readFileSync(cachePath, "utf8"));
			delete (cache as { textVersion?: number }).textVersion;
			writeFileSync(cachePath, JSON.stringify(cache));
			await getCardEmbeddings(vault, FOLDER, undefined, counting);
			expect(calls).toBeGreaterThan(callsFirst); // rebuilt, not served stale
		} finally {
			rmSync(vault, { recursive: true, force: true });
		}
	});
});
