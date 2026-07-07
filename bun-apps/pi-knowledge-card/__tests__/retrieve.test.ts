/**
 * Contract tests for the deterministic knowledge-graph READ side (retrieve.ts).
 *
 * Exercises: readActiveIds, retrieveRecords (ANY-tag match, exclude self,
 * shared-tag ranking, topK), graphHealth (dead-link / MOC-drift / orphans),
 * healGraph (regenerate MOC + prune dead links).
 *
 * Uses a real temp vault with ingested cards — no mocks — so the retrieve
 * ranking is validated against the same tag graph ingest produces.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ingestRecords,
	type KnowledgeRecord,
} from "../src/ingest.ts";
import {
	readActiveIds,
	retrieveRecords,
	graphHealth,
	healGraph,
	formatHealth,
} from "../src/retrieve.ts";

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
	vault = mkdtempSync(join(tmpdir(), "kcard-retrieve-"));
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

describe("readActiveIds", () => {
	test("returns active record ids from a .knowledge.jsonl", () => {
		const kbFile = join(vault, "test.knowledge.jsonl");
		writeFileSync(
			kbFile,
			[
				JSON.stringify(rec({ id: "a:1", status: "active" })),
				JSON.stringify(rec({ id: "a:2", status: "superseded" })),
				JSON.stringify(rec({ id: "a:3", status: "active" })),
				"",
				"not json",
			].join("\n"),
		);
		expect(readActiveIds(kbFile).sort()).toEqual(["a:1", "a:3"]);
	});

	test("returns [] for missing file (new/clean workflow)", () => {
		expect(readActiveIds(join(vault, "nonexistent.knowledge.jsonl"))).toEqual([]);
	});
});

describe("retrieveRecords", () => {
	test("returns cross-source cards ranked by shared-tag count", async () => {
		await ingest([
			rec({ id: "flux2:argv-1", title: "F1", tags: ["argv", "argparse"] }),
			rec({ id: "flux2:argv-2", title: "F2", tags: ["argv", "path-validation"] }),
			rec({ id: "mlx:other", title: "M1", tags: ["cfg", "lever"] }),
		], "flux2");

		const result = await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: ["argv", "argparse"],
			excludeIds: [],
			topK: 5,
		});

		expect(result.count).toBe(2);
		expect(result.cards[0]!.title).toBe("F1"); // 2 shared tags (argv + argparse)
		expect(result.cards[0]!.sharedTags).toBe(2);
		expect(result.cards[1]!.sharedTags).toBe(1); // argv only
		expect(result.cards.every((c) => c.id !== "mlx:other")).toBe(true);
	});

	test("excludes the caller's own cards by source_id", async () => {
		await ingest([
			rec({ id: "flux2:own", title: "Own", tags: ["argv"] }),
			rec({ id: "mlx:cross", title: "Cross", tags: ["argv"] }),
		], "flux2");

		const result = await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: ["argv"],
			excludeIds: ["flux2:own"],
			topK: 5,
		});

		expect(result.count).toBe(1);
		expect(result.cards[0]!.id).toBe("mlx:cross");
		expect(result.excluded).toBe(1);
	});

	test("digest is non-empty and grouped by type", async () => {
		await ingest([
			rec({ id: "a:1", title: "A1", tags: ["argv"], type: "gotcha" }),
			rec({ id: "a:2", title: "A2", tags: ["argv"], type: "lever" }),
		]);

		const result = await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: ["argv"],
			topK: 5,
		});

		expect(result.digest).toContain("GOTCHA");
		expect(result.digest).toContain("LEVER");
		expect(result.digest).toContain("(graph:");
	});

	test("respects topK limit", async () => {
		const records = Array.from({ length: 10 }, (_, i) =>
			rec({ id: `a:${i}`, title: `A${i}`, tags: ["argv"] }),
		);
		await ingest(records);

		const result = await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: ["argv"],
			topK: 3,
		});

		expect(result.count).toBe(3);
		expect(result.scanned).toBe(10);
	});

	test("returns empty for non-overlapping tags", async () => {
		await ingest([rec({ id: "a:1", tags: ["cfg"] })]);

		const result = await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: ["argv"],
		});

		expect(result.count).toBe(0);
		expect(result.digest).toBe("");
	});
});

describe("retrieveRecords — feature-aware ranking (P1)", () => {
	test("a callout card ranks AHEAD of an equal-tag prose card (tie-break boost)", async () => {
		// Both cards share exactly the `argv` tag (shared=1). The callout card
		// gets +0.5 → ranks first; the prose card stays at 1.0 → second.
		//
		// ISOLATION: ids are chosen so the PROSE card sorts FIRST alphabetically
		// ("a:card-one" < "a:card-two"). Without the boost the prose card would
		// win the id tie-break — so the callout ranking first is PROOF the boost
		// fired, not an artifact of id ordering.
		await ingest([
			rec({
				id: "a:card-one", title: "ProseOnly",
				detail: "A plain mention of argv with no callout.",
				tags: ["argv"],
			}),
			rec({
				id: "a:card-two", title: "CalloutBearing",
				detail: "> [!warning] Reject leading-dash argv.\nIt bypasses validation.",
				tags: ["argv"],
			}),
		]);
		const result = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 5,
		});
		expect(result.count).toBe(2);
		expect(result.cards[0]!.title).toBe("CalloutBearing");
		expect(result.cards[0]!.hasCallouts).toBe(true);
		expect(result.cards[1]!.title).toBe("ProseOnly");
		expect(result.cards[1]!.hasCallouts).toBe(false);
		// sharedTags is the tag-overlap count (unaffected by the boost).
		expect(result.cards[0]!.sharedTags).toBe(1);
		expect(result.cards[1]!.sharedTags).toBe(1);
	});

	test("a callout card NEVER displaces a prose card with strictly MORE tag overlap", async () => {
		// Prose card shares 2 tags (shared=2); callout card shares 1 tag
		// (shared+0.5=1.5). The strictly-better-tagged prose card still wins.
		await ingest([
			rec({
				id: "a:prose", title: "ProseTwoTags",
				detail: "Plain prose.",
				tags: ["argv", "argparse"],
			}),
			rec({
				id: "a:callout", title: "CalloutOneTag",
				detail: "> [!warning] something",
				tags: ["argv"],
			}),
		]);
		const result = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv", "argparse"], topK: 5,
		});
		expect(result.cards[0]!.title).toBe("ProseTwoTags");
		expect(result.cards[0]!.sharedTags).toBe(2);
		expect(result.cards[1]!.title).toBe("CalloutOneTag");
		expect(result.cards[1]!.sharedTags).toBe(1);
	});

	test("the digest surfaces the callout headline text for callout-bearing cards", async () => {
		await ingest([
			rec({
				id: "a:callout", title: "WarnCard",
				detail: "Some intro prose before the warning.\n> [!warning] Never run X without the guard.\nMore prose after.",
				tags: ["argv"],
			}),
		]);
		const result = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 5,
		});
		// The callout headline is lifted into the digest line, ahead of the prose.
		expect(result.digest).toContain("[!warning]");
		expect(result.digest).toContain("Never run X without the guard");
		expect(result.cards[0]!.calloutText).toContain("[!warning]");
	});
});

describe("graphHealth", () => {
	test("reports OK on a freshly-ingested graph", async () => {
		await ingest([
			rec({ id: "a:1", tags: ["argv"] }),
			rec({ id: "a:2", tags: ["argv"] }),
		]);

		const h = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(h.ok).toBe(true);
		expect(h.cardCount).toBe(2);
		expect(h.deadLinks.length).toBe(0);
		expect(h.mocMissing).toBe(false);
		expect(h.mocStale).toBe(false);
	});

	test("detects MOC drift after a card is added without re-ingest", async () => {
		await ingest([rec({ id: "a:1", tags: ["argv"] })]);

		// Add a card manually without regenerating the MOC.
		const cardPath = join(vault, FOLDER, "manual-card.md");
		writeFileSync(cardPath, "---\nid: manual\ntags: [zettel, gotcha, argv]\n---\n# Manual\n\n## body\n");

		const h = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(h.mocStale).toBe(true);
		expect(h.ok).toBe(false);
	});

	test("detects missing MOC", async () => {
		await ingest([rec({ id: "a:1" })]);
		// Remove the MOC.
		rmSync(join(vault, MOC));

		const h = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(h.mocMissing).toBe(true);
		expect(h.ok).toBe(false);
	});
});

describe("healGraph", () => {
	test("regenerates a stale MOC", async () => {
		await ingest([rec({ id: "a:1", tags: ["argv"] })]);
		// Add a card manually → MOC is stale.
		writeFileSync(
			join(vault, FOLDER, "manual.md"),
			"---\nid: manual\ntags: [zettel, gotcha, argv]\n---\n# Manual\n\n## body\n",
		);
		const before = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(before.mocStale).toBe(true);

		const healed = await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(healed.mocRegenerated).toBe(true);

		const after = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(after.mocStale).toBe(false);
		expect(after.ok).toBe(true);
	});

	test("regenerates a missing MOC", async () => {
		await ingest([rec({ id: "a:1" })]);
		rmSync(join(vault, MOC));

		const healed = await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(healed.mocRegenerated).toBe(true);

		const after = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(after.mocMissing).toBe(false);
	});

	test("prunes dead [[...]] links in-card", async () => {
		await ingest([rec({ id: "a:1", tags: ["argv"] })]);
		// Manually add a dead link to a card.
		const cardPath = join(vault, FOLDER, "a-1.md");
		const original = readFileSync(cardPath, "utf8");
		// Append a dead link.
		writeFileSync(cardPath, original + "\n- 相關：[[nonexistent-target]]\n");

		const healed = await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		// The dead link should be pruned.
		expect(healed.deadLinksPruned).toBeGreaterThanOrEqual(0);
		const after = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		// After healing, dead links in the folder should be reduced or zero.
		const content = readFileSync(cardPath, "utf8");
		// The nonexistent target link should be gone.
		expect(content).not.toContain("[[nonexistent-target]]");
	});

	test("dedups duplicate 相關：[[...]] lines left by a buggy prior ingest", async () => {
		// Two cards with a shared tag → a-1 has a LIVE `相關：[[b-2]]` link (not a
		// dead link, so the dead-link pruner in step 2 leaves it alone; only the
		// dedup step in step 3 should collapse the duplicate).
		await ingest([
			rec({ id: "a:1", tags: ["argv"] }),
			rec({ id: "b:2", tags: ["argv"] }),
		]);
		const cardPath = join(vault, FOLDER, "a-1.md");
		const original = readFileSync(cardPath, "utf8");
		expect(original).toContain("[[b-2]]"); // live link present
		// Duplicate the live link line.
		const duped = original.replace(
			/^(## 連結\n)(-\s+相關：\[\[b-2\]\]\n)/m,
			"$1$2$2",
		);
		writeFileSync(cardPath, duped);
		const before = readFileSync(cardPath, "utf8");
		expect(before.match(/相關：\[\[b-2\]\]/g)!.length).toBe(2);

		const healed = await healGraph({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(healed.linksDeduped).toBeGreaterThanOrEqual(1);
		const after = readFileSync(cardPath, "utf8");
		expect(after.match(/相關：\[\[b-2\]\]/g)!.length).toBe(1);
	});
});

describe("formatHealth", () => {
	test("produces human-readable output", async () => {
		await ingest([rec({ id: "a:1" })]);
		const h = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		const out = formatHealth(h);
		expect(out).toContain("status:");
		expect(out).toContain("dead-links:");
		expect(out).toContain("card(s)");
	});
});
