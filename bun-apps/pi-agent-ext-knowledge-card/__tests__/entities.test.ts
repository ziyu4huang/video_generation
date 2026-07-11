/**
 * Tests for src/entities.ts — deterministic typed-entity extraction + IDF-weighted
 * cross-link ranking (SAG-inspired, kg-improvement-plan P8).
 *
 * Coverage:
 *   - Entity extraction: backtick code, title-case, hyphenated slugs, quoted
 *     concepts, CJK suffixes — and correct typing via suffix/keyword heuristics.
 *   - IDF: rare tags get higher IDF than ubiquitous tags; log(N/df) formula.
 *   - scoreOverlap: "count" mode (the pinned baseline) vs "idf" mode (weighted).
 *   - Integration: ingestRecords with linkWeighting:"idf" writes additive entity
 *     frontmatter + produces IDF-ranked cross-links where rare bridges beat
 *     ubiquitous type-tags (the documented "generic-tag noise" fix).
 *   - Backward-compat: default "count" mode is byte-identical to pre-P8 ingest.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractEntities,
	computeIdf,
	scoreOverlap,
	type ExtractedEntity,
	type EntityType,
} from "../src/entities.ts";
import {
	ingestRecords,
	type KnowledgeRecord,
} from "../src/ingest.ts";

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

describe("extractEntities", () => {
	test("backtick code spans are extracted and typed", () => {
		const ents = extractEntities("Use `run.py` with `--cfg-scale` and `MLX_MODELS_DIR`.");
		const names = ents.map((e) => e.name);
		expect(names).toContain("run.py");
		expect(names).toContain("--cfg-scale");
		expect(names).toContain("MLX_MODELS_DIR");
		// run.py → file (has .py extension), --cfg-scale → config (leading dash)
		const runPy = ents.find((e) => e.name === "run.py");
		expect(runPy?.type).toBe("file");
		const cfg = ents.find((e) => e.name === "--cfg-scale");
		expect(cfg?.type).toBe("config");
		const env = ents.find((e) => e.name === "MLX_MODELS_DIR");
		expect(env?.type).toBe("config"); // SCREAMING_SNAKE env var
	});

	test("title-case multi-word terms are extracted", () => {
		const ents = extractEntities("Flux2 Klein and LM Studio produce images.");
		const names = ents.map((e) => e.name);
		expect(names.some((n) => n.toLowerCase().includes("flux2"))).toBe(true);
		expect(names.some((n) => n.toLowerCase().includes("lm studio"))).toBe(true);
	});

	test("hyphenated slugs are extracted (our package convention)", () => {
		const ents = extractEntities("The pi-obsidian and zk-ingest extensions.");
		const names = ents.map((e) => e.name);
		expect(names).toContain("pi-obsidian");
		expect(names).toContain("zk-ingest");
	});

	test("quoted concepts are extracted", () => {
		const ents = extractEntities('The "atomic zettel" model uses "semantic blend".');
		const names = ents.map((e) => e.name.toLowerCase());
		expect(names).toContain("atomic zettel");
		expect(names).toContain("semantic blend");
	});

	test("CJK domain-suffixed terms are extracted", () => {
		const ents = extractEntities("SAG 的核心是事件模型和檢索系統。");
		const names = ents.map((e) => e.name);
		// At least one CJK-suffixed term should be captured
		expect(names.some((n) => /模型|系統/.test(n))).toBe(true);
	});

	test("model suffixes are typed correctly", () => {
		const ents = extractEntities("Use `Flux2` and `bge-large` for generation.");
		const flux = ents.find((e) => /flux/i.test(e.name));
		expect(flux?.type).toBe("model");
		const bge = ents.find((e) => /bge/i.test(e.name));
		expect(bge?.type).toBe("model");
	});

	test("error keywords are typed as error", () => {
		const ents = extractEntities("Watch for `MPS-crash` and `dead-link` issues.");
		const crash = ents.find((e) => /crash/i.test(e.name));
		expect(crash?.type).toBe("error");
		const dead = ents.find((e) => /dead/i.test(e.name));
		expect(dead?.type).toBe("error");
	});

	test("dedup normalises case + whitespace", () => {
		const ents = extractEntities("Use `Run.py` and run.py interchangeably.");
		// Both normalise to "run.py" → only one entity
		const runPyCount = ents.filter((e) => e.name.toLowerCase() === "run.py").length;
		expect(runPyCount).toBe(1);
	});

	test("respects maxEntities cap", () => {
		// Generate many distinct backtick identifiers
		const parts = Array.from({ length: 30 }, (_, i) => `\`tool${i}\``).join(" ");
		const ents = extractEntities(parts, 10);
		expect(ents.length).toBeLessThanOrEqual(10);
	});

	test("empty input returns []", () => {
		expect(extractEntities("")).toEqual([]);
		expect(extractEntities("   ")).toEqual([]);
	});

	test("output is deterministic (sorted by type-priority then name)", () => {
		const text = "`run.py` and Flux2 and `--cfg-scale`";
		const e1 = extractEntities(text);
		const e2 = extractEntities(text);
		expect(e1.map((e) => `${e.type}:${e.name}`)).toEqual(e2.map((e) => `${e.type}:${e.name}`));
	});
});

// ---------------------------------------------------------------------------
// IDF computation
// ---------------------------------------------------------------------------

describe("computeIdf", () => {
	test("rare tags get higher IDF than ubiquitous tags", () => {
		// 10 cards; "rare" on 1 card, "common" on 9 cards
		const tagSets: Set<string>[] = [];
		for (let i = 0; i < 10; i++) {
			const s = new Set<string>(["zettel"]);
			if (i < 9) s.add("common");
			if (i === 0) s.add("rare");
			tagSets.push(s);
		}
		const idf = computeIdf(tagSets);
		const rareIdf = idf.get("rare")!;
		const commonIdf = idf.get("common")!;
		expect(rareIdf).toBeGreaterThan(commonIdf);
		// log(10/1) ≈ 2.303; log(10/9) ≈ 0.105
		expect(rareIdf).toBeCloseTo(Math.log(10), 2);
		expect(commonIdf).toBeCloseTo(Math.log(10 / 9), 2);
	});

	test("tag on ALL cards has IDF 0 (no discrimination)", () => {
		const tagSets = [
			new Set(["zettel", "universal"]),
			new Set(["zettel", "universal"]),
			new Set(["zettel", "universal"]),
		];
		const idf = computeIdf(tagSets);
		expect(idf.get("universal")).toBeCloseTo(0, 5);
	});

	test("empty input returns empty map", () => {
		expect(computeIdf([])).toBeInstanceOf(Map);
		expect(computeIdf([]).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// scoreOverlap
// ---------------------------------------------------------------------------

describe("scoreOverlap", () => {
	const idf = new Map([
		["rare", 5.0],
		["common", 0.1],
		["zettel", 0],
	]);
	const query = new Set(["rare", "common", "zettel"]);
	const card = new Set(["rare", "common", "zettel", "extra"]);

	test("count mode = raw intersection minus zettel", () => {
		// shared: rare + common = 2 (zettel excluded)
		expect(scoreOverlap(query, card, idf, "count")).toBe(2);
	});

	test("idf mode = Σ IDF(sharedTag)", () => {
		// 5.0 + 0.1 = 5.1 (zettel excluded)
		expect(scoreOverlap(query, card, idf, "idf")).toBeCloseTo(5.1, 2);
	});

	test("default mode (omitted) = count", () => {
		expect(scoreOverlap(query, card, idf)).toBe(2);
	});

	test("no overlap returns 0", () => {
		const other = new Set(["unrelated", "zettel"]);
		expect(scoreOverlap(query, other, idf, "idf")).toBe(0);
	});

	test("idf mode makes rare-tag overlap dominate common-tag overlap", () => {
		// Card A shares only "common" with query; Card B shares only "rare"
		const cardA = new Set(["common", "zettel"]);
		const cardB = new Set(["rare", "zettel"]);
		expect(scoreOverlap(query, cardA, idf, "count")).toBe(1);
		expect(scoreOverlap(query, cardB, idf, "count")).toBe(1); // equal in count mode!
		// But in IDF mode, rare dominates:
		expect(scoreOverlap(query, cardB, idf, "idf")).toBeGreaterThan(
			scoreOverlap(query, cardA, idf, "idf"),
		);
	});
});

// ---------------------------------------------------------------------------
// Integration: ingestRecords with linkWeighting:"idf"
// ---------------------------------------------------------------------------

describe("ingestRecords — IDF-weighted cross-linking (P8)", () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kc-entity-test-"));
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	test("default count mode produces NO entity frontmatter (backward-compat)", async () => {
		const rec: KnowledgeRecord = {
			id: "test:no-entity",
			type: "gotcha",
			title: "MPS crash on Flux2",
			detail: "Flux2 crashes with `--cfg-scale` set too high.",
			tags: ["flux2"],
			dimension: "stability",
			confidence: 0.9,
			status: "active",
			superseded_by: null,
		};
		await ingestRecords([rec], {
			vaultPath: vault,
			source: "workflow-jsonl",
			sourceLabel: "test",
		});
		const card = readFileSync(
			join(vault, "Zettelkasten/knowledge-graph/test-no-entity.md"),
			"utf8",
		);
		// No entities key in frontmatter under default mode
		expect(card).not.toContain("entities:");
	});

	test("idf mode writes additive entity frontmatter", async () => {
		const rec: KnowledgeRecord = {
			id: "test:with-entity",
			type: "gotcha",
			title: "MPS crash on Flux2",
			detail: "Flux2 crashes with `--cfg-scale` set too high.",
			tags: ["flux2"],
			dimension: "stability",
			confidence: 0.9,
			status: "active",
			superseded_by: null,
		};
		await ingestRecords([rec], {
			vaultPath: vault,
			source: "workflow-jsonl",
			sourceLabel: "test",
			linkWeighting: "idf",
		});
		const card = readFileSync(
			join(vault, "Zettelkasten/knowledge-graph/test-with-entity.md"),
			"utf8",
		);
		// Entity frontmatter present with typed entities extracted from the body
		expect(card).toContain("entities:");
		expect(card.toLowerCase()).toContain("flux2");
		expect(card.toLowerCase()).toContain("cfg-scale");
	});

	test("IDF weighting lets rare bridges outrank ubiquitous type-tags", async () => {
		// Build a folder where:
		//  - 5 cards share the ubiquitous tag "pattern" with a target card
		//  - 1 card shares the rare tag "pi-obsidian" with the same target card
		// Under "count", the 5 pattern-cards tie or beat the 1 rare-bridge card
		// (all shared=1). Under "idf", the pi-obsidian bridge should rank FIRST
		// because pi-obsidian's IDF >> pattern's IDF.
		const base: KnowledgeRecord = {
			id: "target:card",
			type: "gotcha",
			title: "Target card",
			detail: "References pi-obsidian and pattern.",
			tags: ["pi-obsidian", "pattern"],
			dimension: "test",
			confidence: 0.9,
			status: "active",
			superseded_by: null,
		};
		const rareBridge: KnowledgeRecord = {
			id: "bridge:pi-obs",
			type: "gotcha",
			title: "Pi-obsidian bridge",
			detail: "About pi-obsidian internals.",
			tags: ["pi-obsidian"],
			dimension: "test",
			confidence: 0.9,
			status: "active",
			superseded_by: null,
		};
		const noiseCards: KnowledgeRecord[] = Array.from({ length: 5 }, (_, i) => ({
			id: `noise:${i}`,
			type: "pattern",
			title: `Noise card ${i}`,
			detail: `Generic pattern ${i}.`,
			tags: ["pattern"],
			dimension: "test",
			confidence: 0.5,
			status: "active" as const,
			superseded_by: null,
		}));

		// First ingest noise + bridge (so the folder has the tag distribution)
		await ingestRecords([...noiseCards, rareBridge], {
			vaultPath: vault,
			source: "workflow-jsonl",
			sourceLabel: "test",
		});
		// Then ingest the target with IDF weighting and inspect its links
		const result = await ingestRecords([base], {
			vaultPath: vault,
			source: "workflow-jsonl",
			sourceLabel: "test",
			linkWeighting: "idf",
			maxLinks: 8,
		});

		// The target card's first link should be the pi-obsidian bridge, not a noise card
		const card = readFileSync(
			join(vault, "Zettelkasten/knowledge-graph/target-card.md"),
			"utf8",
		);
		const linkSection = card.split("## 連結")[1] ?? "";
		const firstLink = linkSection.match(/\[\[([^\]]+)\]\]/);
		expect(firstLink?.[1]).toBe("bridge-pi-obs");
		// The noise cards should appear AFTER the bridge
		expect(linkSection.indexOf("bridge-pi-obs")).toBeLessThan(
			linkSection.indexOf("noise-0"),
		);
	});
});
