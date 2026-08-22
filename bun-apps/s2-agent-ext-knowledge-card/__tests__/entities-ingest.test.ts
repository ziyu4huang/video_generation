/**
 * Integration half of the former __tests__/entities.test.ts: ingestRecords with
 * linkWeighting:"idf" writes additive entity frontmatter and produces
 * IDF-ranked cross-links where rare bridges beat ubiquitous type-tags (the
 * documented "generic-tag noise" fix). Backward-compat: default "count" mode is
 * byte-identical to pre-P8 ingest.
 *
 * The pure extractEntities/computeIdf/scoreOverlap tests moved WITH the module
 * into core-interface (tests/entities.test.ts) — see the tier rule (bun-apps/tests/dep-guard.test.ts). This half stays
 * because it exercises the hub's ingest path, which core-interface may not
 * import.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEntities } from "@repo/s2-agent-core-interface";
import { ingestRecords } from "../src/ingest.ts";
import type { KnowledgeRecord } from "../src/types.ts";

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

