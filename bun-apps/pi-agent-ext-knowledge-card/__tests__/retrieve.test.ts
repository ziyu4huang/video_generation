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
import { buildRagTask } from "../extensions/knowledge-card.ts";
import type { Embedder } from "../src/semantic.ts";

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

	describe("bodyMatch recall path (kg-improvement-plan follow-on)", () => {
		test("bodyMatch:false is byte-identical to tag-only (no body rescue)", async () => {
			await ingest([
				rec({ id: "a:tag-hit", title: "TagHit", tags: ["argv"], detail: "general note." }),
				rec({ id: "b:body-only", title: "BodyOnly", tags: ["unrelated-xyz"], detail: "the argv token lives in prose, not tags." }),
			], "flux2");
			const result = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 5 });
			expect(result.count).toBe(1); // only the tag-matching card
			expect(result.cards[0]!.id).toBe("a:tag-hit");
		});

		test("bodyMatch:true rescues a card whose query token is in body not tags", async () => {
			await ingest([
				rec({ id: "a:tag-hit", title: "TagHit", tags: ["argv"], detail: "general note." }),
				rec({ id: "b:body-only", title: "BodyOnly", tags: ["unrelated-xyz"], detail: "the argv token lives in prose, not tags." }),
			], "flux2");
			const result = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 5, bodyMatch: true });
			expect(result.count).toBe(2); // tag hit + body rescue
			const ids = result.cards.map((c) => c.id);
			expect(ids).toContain("a:tag-hit");
			expect(ids).toContain("b:body-only");
		});

		test("bodyMatch:true keeps tag matches ranked ABOVE body-only matches (precision)", async () => {
			await ingest([
				rec({ id: "a:tag-hit", title: "TagHit", tags: ["argv"], detail: "general note." }),
				rec({ id: "b:body-only", title: "BodyOnly", tags: ["unrelated-xyz"], detail: "the argv token lives in prose, not tags." }),
			], "flux2");
			const result = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 5, bodyMatch: true });
			expect(result.cards[0]!.id).toBe("a:tag-hit"); // tag×2 outranks body×1
			expect(result.cards[1]!.id).toBe("b:body-only");
		});

		test("bodyMatch:true still skips a card with neither tag nor body overlap", async () => {
			await ingest([
				rec({ id: "a:tag-hit", title: "TagHit", tags: ["argv"], detail: "general note." }),
				rec({ id: "c:noise", title: "Noise", tags: ["zzz-none"], detail: "completely unrelated prose here." }),
			], "flux2");
			const result = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 5, bodyMatch: true });
			expect(result.count).toBe(1);
			expect(result.cards[0]!.id).toBe("a:tag-hit");
		});
	});

	describe("slugDom precision path (kg-improvement-plan iter-2)", () => {
		test("slugDom:false (default) is byte-identical to bodyMatch-only — drift guard", async () => {
			await ingest([
				rec({ id: "proj:ltx-dasiwa-mlx-integration", title: "SlugTopic", tags: ["unrelated-xyz"], detail: "generic prose with no query token." }),
				rec({ id: "ltx:audio", title: "TagHit", tags: ["ltx"], detail: "general note." }),
			], "flux2");
			// slugDom off → slug card has 0 tag + 0 body overlap → excluded (unchanged)
			const off = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["ltx", "dasiwa", "mlx", "integration"], topK: 5, bodyMatch: true });
			expect(off.cards.map((c) => c.id)).not.toContain("proj:ltx-dasiwa-mlx-integration");
		});

		test("slugDom rescues a card whose id names the query topic but tags are generic", async () => {
			await ingest([
				// target: 0 tag + 0 body overlap, but slug overlaps 4 query tokens → dominant
				rec({ id: "proj:ltx-dasiwa-mlx-integration", title: "SlugTopic", tags: ["unrelated-xyz"], detail: "generic prose with no query token here." }),
				// decoys: tag overlap (ltx) + slug overlap only 1 → must NOT dominate
				rec({ id: "ltx:audio-config", title: "Audio", tags: ["ltx"], detail: "audio lever." }),
				rec({ id: "ltx:hq-mode", title: "Hq", tags: ["ltx"], detail: "hq lever." }),
			], "flux2");
			const on = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["ltx", "dasiwa", "mlx", "integration"], topK: 5, bodyMatch: true, slugDom: true });
			expect(on.cards.map((c) => c.id)).toContain("proj:ltx-dasiwa-mlx-integration");
			expect(on.cards[0]!.id).toBe("proj:ltx-dasiwa-mlx-integration"); // slug×4=16 beats tag decoys (=2)
		});

		test("slugDom ≥3 gate: a card with only 2 slug-token overlap does NOT dominate", async () => {
			await ingest([
				// slug 'ltx-dasiwa-only' overlaps 2 query tokens (ltx, dasiwa) → below gate
				rec({ id: "ltx:dasiwa-only", title: "TwoToken", tags: ["zzz-none"], detail: "no query token in body." }),
				rec({ id: "ltx:audio", title: "TagHit", tags: ["ltx"], detail: "general note." }),
			], "flux2");
			const on = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["ltx", "dasiwa", "mlx", "integration"], topK: 5, bodyMatch: true, slugDom: true });
			// gate not fired → the tag-matching card (shared=1 → score 2) ranks #1,
			// the 2-token slug card (fallback score 0) does NOT jump to top.
			expect(on.cards[0]!.id).toBe("ltx:audio");
			expect(on.cards.find((c) => c.id === "ltx:dasiwa-only") ?? null).not.toBe(on.cards[0]);
		});

		test("slugDom works standalone (without bodyMatch) for a strong slug match", async () => {
			await ingest([
				rec({ id: "proj:ltx-dasiwa-mlx-integration", title: "SlugTopic", tags: ["unrelated-xyz"], detail: "generic prose." }),
				rec({ id: "ltx:audio", title: "TagHit", tags: ["ltx"], detail: "note." }),
			], "flux2");
			const on = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["ltx", "dasiwa", "mlx", "integration"], topK: 5, slugDom: true });
			expect(on.cards.map((c) => c.id)).toContain("proj:ltx-dasiwa-mlx-integration");
			expect(on.cards[0]!.id).toBe("proj:ltx-dasiwa-mlx-integration");
		});
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

describe("ranking-split drift guard (consolidation cycle Stage 3)", () => {
	// BY-DESIGN contract (pinned here so a future edit can't silently change one
	// read path's callout handling without the other):
	//   - retrieveRecords (deterministic lib, reads frontmatter at rank time)
	//     APPLIES a bounded +0.5 callout boost (tie-break only).
	//   - zk_ask's buildRagTask (agent computes score from search results, no
	//     frontmatter at Step 3) does NOT put a callout term in the Step-3 score
	//     formula — it SURFACES callouts via the Step-4 instruction instead.
	// If either side changes, update BOTH + this test + ARCHITECTURE.md.

	test("retrieveRecords applies the callout boost (boost term present in source)", async () => {
		// Sanity: the boost is wired and observable (rank flip on a tag tie).
		await ingest([
			rec({ id: "d:a", title: "Prose", detail: "plain prose", tags: ["argv"] }),
			rec({ id: "d:b", title: "Callout", detail: "> [!warning] x", tags: ["argv"] }),
		]);
		const result = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 5,
		});
		expect(result.cards[0]!.title).toBe("Callout");
		expect(result.cards[0]!.hasCallouts).toBe(true);
	});

	test("buildRagTask Step-3 score formula has NO callout term (surfaces, not boosts)", () => {
		// Import the pure task builder (no vault / no agent needed).
		// The deterministic score line is "0.7 × search_score ... + 0.3 × link_count"
		// with NO callout term. zk_ask surfaces callouts via the Step-4 instruction
		// instead (asserted below). If someone adds a callout term to Step 3, this
		// guard fails and forces the by-design decision to be revisited.
		const t = buildRagTask("q", 2, 8, false, false);
		expect(t).toContain("0.7 × search_score");
		expect(t).toContain("0.3 × link_count");
		// A callout term MUST NOT appear on the score-formula line.
		const scoreLine = t.split("\n").find((l) => l.includes("search_score"))!;
		expect(scoreLine.toLowerCase()).not.toContain("callout");
	});

	test("buildRagTask carries the Step-4 callout-surfacing instruction (the zk_ask lever)", () => {
		const t = buildRagTask("q", 2, 8, false, false);
		expect(t).toContain("Feature surfacing (P1)");
		expect(t).toContain("> [!warning|tip|info|caution|...]");
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

describe("retrieveRecords trace (Phase C observability)", () => {
	test("includeTrace omitted → trace undefined (drift-guard: byte-identical)", async () => {
		await ingest([rec({ id: "t:a", title: "A", tags: ["argv"] })]);
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 4, bodyMatch: true });
		expect(r.trace).toBeUndefined();
	});

	test("includeTrace:false → trace undefined (same as omitted)", async () => {
		await ingest([rec({ id: "t:a", title: "A", tags: ["argv"] })]);
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 4, bodyMatch: true, includeTrace: false });
		expect(r.trace).toBeUndefined();
	});

	test("includeTrace:true (lexical path) → trace present, semanticUsed=false, source='lexical', scores in rank order", async () => {
		await ingest([
			rec({ id: "t:a", title: "A argv", tags: ["argv"] }),
			rec({ id: "t:b", title: "B argv extra", tags: ["argv", "extra"] }),
		]);
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 4, bodyMatch: true, includeTrace: true });
		expect(r.trace).toBeDefined();
		expect(r.trace!.semanticUsed).toBe(false);
		expect(r.trace!.candidatePool).toBeGreaterThan(0);
		expect(r.trace!.options.bodyMatch).toBe(true);
		expect(r.trace!.cards.length).toBe(r.cards.length);
		for (const c of r.trace!.cards) expect(c.source).toBe("lexical");
		const scores = r.trace!.cards.map((c) => c.score);
		for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
		expect(r.trace!.cards.every((c) => Number.isFinite(c.sharedTags))).toBe(true);
	});

	test("includeTrace:true (semantic path) → semanticUsed=true, source classifies both vs semantic", async () => {
		// lex = lexical hit (tag 'argv'); sem = ZERO tag overlap, surfaces only via
		// vector nearness (semantic-only). The injected embedder puts sem near the query.
		await ingest([
			rec({ id: "t:lex", title: "Lexical argv card", tags: ["argv"], detail: "plain" }),
			rec({ id: "t:sem", title: "Semantic zzz card", tags: ["zzz"], detail: "plain" }),
		]);
		const emb: Embedder = async (texts) => texts.map((t) => (/zzz/i.test(t) ? [1, 0] : [0, 1]));
		const r = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], queryText: "zzz query",
			topK: 4, semantic: true, _testEmbedder: emb, includeTrace: true,
		});
		expect(r.trace).toBeDefined();
		expect(r.trace!.semanticUsed).toBe(true);
		expect(r.trace!.options.semantic).toBe(true);
		const byId = new Map(r.trace!.cards.map((c) => [c.id, c]));
		// With 2 cards both land in the semantic top-12, so the lexical card is
		// 'both' (in lexPool AND semTop); the zero-tag-overlap card is 'semantic'.
		expect(byId.get("t:lex")!.source).toBe("both");
		expect(byId.get("t:sem")!.source).toBe("semantic");
		// the semantic-gap card (cosNorm 1, α=0.18 → 0.82) outranks the lexical-only
		// card (lexRank 1, cosNorm 0 → 0.18) — proven by rank order in the trace.
		const semRank = r.trace!.cards.findIndex((c) => c.id === "t:sem");
		const lexRank = r.trace!.cards.findIndex((c) => c.id === "t:lex");
		expect(semRank).toBeLessThan(lexRank);
		expect(r.trace!.cards[semRank].score).toBeGreaterThan(r.trace!.cards[lexRank].score);
	});
});

describe("retrieveRecords — typed relations across the seam (ticket 03 T5, D2)", () => {
	// T5 plumbs the card's typed edges across the hermes↔zk retrieve seam as the
	// OPTIONAL `RetrievedCard.relations` carrier (undefined for cards with no
	// `relations:` frontmatter — the dictionary ingest path emits entities only,
	// never relations). retrieve.ts is a faithful PASS-THROUGH: it reads the
	// on-disk `relations:` block (the form T4's serializer write-back emits) and
	// does NOT re-normalize — canonicalization is the serializer's job (D3, T4's
	// parseRelations). The fixture below carries the CANONICAL predicate
	// ("references") the serializer emits, proving the carrier works AND that
	// T4's canonical form survives retrieval intact.

	/** Write a card .md directly with the ingest schema, optionally carrying a
	 *  `relations:` block (ingest itself writes entities only — relations are
	 *  authored by an LLM extractor / serializer write-back, Phase-2+T4). */
	function writeCard(id: string, tag: string, relationsBlock: string | null) {
		const dir = join(vault, FOLDER);
		mkdirSync(dir, { recursive: true });
		const fm = [
			"---",
			`id: ${id}`,
			"created: 2026-01-01",
			`tags: [zettel, ${tag}]`,
			"sources: [test]",
			"source: test",
			`source_id: ${id}`,
			"record_type: gotcha",
			"status: active",
			'superseded_by: ""',
			"confidence: 0.8",
			...(relationsBlock ? [relationsBlock] : []),
			"---",
		].join("\n");
		const body = `# ${id}\n\n## 核心想法\nDetail about ${id}.\n\n## 證據 / 脈絡\n- type: gotcha\n\n## 連結\n- (no shared-tag neighbours yet)\n`;
		writeFileSync(join(dir, `${id}.md`), `${fm}\n${body}`);
	}

	test("a card with a `relations:` block surfaces typed edges on RetrievedCard", async () => {
		writeCard("rel-card", "argv", "relations:\n  - s: a\n    rel: references\n    o: b");
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 5 });
		expect(r.count).toBe(1);
		expect(r.cards[0]!.relations).toEqual([{ s: "a", rel: "references", o: "b" }]);
	});

	test("a plain card (dictionary path, no relations) → RetrievedCard.relations is undefined", async () => {
		// Ingest through the real dictionary path (emits entities only, never
		// relations) to prove the default path leaves the carrier absent.
		await ingest([rec({ id: "plain:a", title: "Plain", tags: ["argv"] })], "flux2");
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], topK: 5 });
		expect(r.count).toBe(1);
		expect(r.cards[0]!.relations).toBeUndefined();
	});

	test("fix-wave 03 FIX5b: SEMANTIC path (buildRetrievedCard) populates relations for a semantic-only card", async () => {
		// A card with ZERO tag overlap (tag 'zzz' vs query tags ['argv']) that
		// surfaces ONLY through the semantic blend — i.e. it is built by
		// buildRetrievedCard, not the lexical loop. The card carries a canonical
		// `relations:` block; the carrier must be populated on the built card.
		writeCard("t:sem-rel", "zzz", "relations:\n  - s: a\n    rel: references\n    o: b");
		// Injected embedder: the semantic card's text matches the query vector.
		const emb: Embedder = async (texts) =>
			texts.map((t) => (/Detail about t:sem-rel/i.test(t) || /zzz/i.test(t) ? [1, 0] : [0, 1]));
		const r = await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: ["argv"],
			queryText: "zzz query",
			topK: 4,
			semantic: true,
			_testEmbedder: emb,
			includeTrace: true,
		});
		expect(r.trace!.semanticUsed).toBe(true); // sanity: the blend ran
		const got = r.cards.find((c) => c.id === "t:sem-rel");
		expect(got).toBeDefined();
		expect(got!.relations).toEqual([{ s: "a", rel: "references", o: "b" }]);
		// And the trace confirms it was classified semantic (built, not lexical).
		const traced = r.trace!.cards.find((c) => c.id === "t:sem-rel");
		expect(traced!.source).toBe("semantic");
	});
});

describe("GraphHealthResult.coverage (additive dimension — drift guard)", () => {
	test("graphHealth leaves coverage undefined by default (structural-only; populated by the caller layer)", async () => {
		const v = mkdtempSync(join(tmpdir(), "kc-cov-dg-"));
		try {
			await ingestRecords(
				[
					{ id: "wf:a", type: "gotcha", title: "T", detail: "d", tags: ["x"], dimension: "correctness", confidence: 0.8, status: "active", superseded_by: null },
				],
				{ vaultPath: v, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:test" },
			);
			const h = await graphHealth({ vaultPath: v });
			// The field EXISTS on the type (additive) but is NOT populated by graphHealth —
			// the zk.health host-fn / zk-query CLI attach it. This pins the contract:
			// retrieve.ts stays structural-only (no runtime ingest coupling).
			expect(h.coverage).toBeUndefined();
			expect(h.cardCount).toBeGreaterThanOrEqual(1);
		} finally {
			rmSync(v, { recursive: true, force: true });
		}
	});
});
