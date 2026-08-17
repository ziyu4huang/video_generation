/**
 * LeanRAG ② (ticket 05) — retrieval auto tree-expansion contract tests.
 *
 * When agg-L*-* MOCs exist in the convergence folder, lineage-matched
 * aggregation summaries are appended AFTER the ranked list (≤3, layer-desc,
 * viaTree marker). Ranking stays authoritative. No agg files → ranked-only
 * result, byte-identical to pre-ticket-05 behavior (golden, drift-guard).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRecords } from "../src/ingest.ts";
import type { KnowledgeRecord } from "../src/types.ts";
import { retrieveRecords } from "../src/retrieve.ts";

let vault: string;
const FOLDER = "Zettelkasten/knowledge-graph";
const MOC = "Tags/Knowledge Graph.md";

function rec(over: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
	return {
		id: "test:base",
		type: "gotcha",
		title: "Base gotcha",
		detail: "Some detail about the gotcha.",
		tags: ["path-safety", "argv"],
		dimension: "correctness",
		confidence: 0.8,
		status: "active",
		superseded_by: null,
		...over,
	};
}

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-retrieve-tree-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

async function ingest(records: KnowledgeRecord[], sourceLabel = "test") {
	return ingestRecords(records, {
		vaultPath: vault,
		source: "workflow-jsonl",
		sourceLabel,
		folder: FOLDER,
		mocPath: MOC,
	});
}

function aggFile(name: string, fields: Record<string, string | number | string[]>) {
	const lines = ["---"];
	for (const [k, v] of Object.entries(fields)) {
		if (Array.isArray(v)) {
			lines.push(`${k}:`);
			for (const item of v) lines.push(`  - ${item}`);
		} else {
			lines.push(`${k}: ${v}`);
		}
	}
	lines.push("---", "", "derived aggregation body");
	writeFileSync(join(vault, FOLDER, name), lines.join("\n"));
}

describe("retrieveRecords — LeanRAG ② tree expansion (ticket 05)", () => {
	test("no agg files → ranked-only, unchanged (golden)", async () => {
		await ingest([
			rec({ id: "test:card-a", tags: ["alpha"] }),
			rec({ id: "test:card-b", tags: ["beta"] }),
		]);
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["alpha", "beta"] });
		expect(r.cards.length).toBe(2);
		expect(r.cards.every((c) => c.viaTree !== true)).toBe(true);
		expect(r.digest.length).toBeGreaterThan(0);
		expect(r.cards[0]!.sharedTags).toBeGreaterThanOrEqual(r.cards[1]!.sharedTags);
	});

	test("agg tree + lineage match → appended after ranked, ranking untouched", async () => {
		await ingest([
			rec({ id: "test:card-a", tags: ["alpha"] }),
			rec({ id: "test:card-b", tags: ["beta"] }),
		]);
		aggFile("agg-L0-0.md", {
			id: "agg:0:0",
			layer: 0,
			sources: ["test:card-a"],
			entities: ["alpha", "beta"],
			summary: "cluster about alpha",
		});
		// Parent node's lineage points at the CHILD NODE (not a ranked card id)
		// → must NOT match the ranked set.
		aggFile("agg-L1-0.md", {
			id: "agg:1:0",
			layer: 1,
			sources: ["agg:0:0"],
			entities: ["alpha"],
			summary: "root node",
		});
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["alpha", "beta"] });
		expect(r.cards.length).toBe(3);
		expect(r.cards[0]!.id).toBe("test:card-a");
		expect(r.cards[1]!.id).toBe("test:card-b");
		expect(r.cards[0]!.viaTree).toBeUndefined();
		const agg = r.cards[2]!;
		expect(agg.type).toBe("aggregation");
		expect(agg.viaTree).toBe(true);
		expect(agg.sharedTags).toBe(0);
		expect(agg.title).toBe("Aggregation L0");
		expect(agg.detail).toContain("cluster about alpha");
	});

	test("cap: ≤3 appended, nearest layers first (layer desc)", async () => {
		await ingest([rec({ id: "test:card-a", tags: ["alpha"] })]);
		for (const [i, layer] of [0, 0, 1, 1, 2].entries()) {
			aggFile(`agg-L${layer}-${i}.md`, {
				id: `agg:${layer}:${i}`,
				layer,
				sources: ["test:card-a"],
				entities: ["alpha"],
				summary: `summary layer ${layer} variant ${i}`,
			});
		}
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["alpha"] });
		const viaTree = r.cards.filter((c) => c.viaTree === true);
		expect(viaTree.length).toBe(3);
		expect(viaTree[0]!.title).toBe("Aggregation L2");
		expect(r.cards[0]!.id).toBe("test:card-a");
	});

	test("agg present but lineage disjoint → no append (byte-same as golden)", async () => {
		await ingest([
			rec({ id: "test:card-a", tags: ["alpha"] }),
			rec({ id: "test:card-b", tags: ["beta"] }),
		]);
		aggFile("agg-L0-9.md", {
			id: "agg:0:9",
			layer: 0,
			sources: ["unrelated-id"],
			entities: ["gamma"],
			summary: "unrelated cluster",
		});
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["alpha", "beta"] });
		expect(r.cards.length).toBe(2);
		expect(r.cards.every((c) => c.viaTree !== true)).toBe(true);
	});
});
