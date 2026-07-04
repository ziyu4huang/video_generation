/**
 * Contract tests for the deterministic knowledge-graph RETRIEVE + HEALTH primitives.
 *
 * The closed-loop claim (the whole point of `retrieve.ts`) is asserted here: feed
 * records from TWO different sources with overlapping tags via `ingestRecords`,
 * then retrieve with one source's ids excluded and confirm the digest surfaces
 * ONLY cards the other source contributed. The health gate is asserted to be OK
 * on a clean ingest, and to flag MOC drift when the MOC is corrupted.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ingestRecords,
	type KnowledgeRecord,
} from "../src/ingest.ts";
import {
	retrieveRecords,
	formatRetrieveDigest,
	graphHealth,
	readActiveIds,
	type RetrieveOptions,
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

/** Ingest a batch from a named source label. */
async function ingest(records: KnowledgeRecord[], sourceLabel: string) {
	return ingestRecords(records, {
		vaultPath: vault,
		source: "workflow-jsonl",
		sourceLabel,
		folder: FOLDER,
		mocPath: MOC,
	});
}

const FLUX2_RECORDS: KnowledgeRecord[] = [
	rec({ id: "flux2:own-gotcha", title: "flux2 own gotcha", tags: ["argv", "path-safety", "schema-consistency"], detail: "flux2-specific" }),
	rec({ id: "flux2:other", title: "flux2 other", tags: ["argv"], detail: "flux2 argv thing" }),
];
const MLX_RECORDS: KnowledgeRecord[] = [
	rec({ id: "mlx-review:argparse-private", title: "mlx argparse private attrs", tags: ["argparse", "argparse-integrity", "argv"], detail: "parser._actions is private." }),
	rec({ id: "mlx-review:path-bug", title: "mlx path validation bug", tags: ["path-safety", "path-validation"], detail: "resolvePath misses a case." }),
];

describe("retrieveRecords — closed loop", () => {
	beforeEach(async () => {
		await ingest(FLUX2_RECORDS, "workflow-jsonl:flux2");
		await ingest(MLX_RECORDS, "workflow-jsonl:mlx-review");
	});

	test("ANY-tag match returns cards from across sources", async () => {
		const r = await retrieveRecords({ vaultPath: vault, tags: ["argparse"], topK: 10 });
		expect(r.matched).toBe(1);
		expect(r.cards[0]!.id).toBe("mlx-review:argparse-private");
	});

	test("excludeIds surfaces ONLY cross-workflow cards (the proof)", async () => {
		// flux2 retrieves argv/path cards, excluding its OWN ids → only mlx-review cards.
		const opts: RetrieveOptions = {
			vaultPath: vault,
			tags: ["argv", "path-safety"],
			excludeIds: ["flux2:own-gotcha", "flux2:other"],
			topK: 10,
		};
		const r = await retrieveRecords(opts);
		expect(r.returned).toBe(2);
		const ids = r.cards.map((c) => c.id).sort();
		expect(ids).toEqual(["mlx-review:argparse-private", "mlx-review:path-bug"]);
		// None of the returned ids are flux2's own — the closed-loop invariant.
		for (const id of ids) expect(id.startsWith("flux2:")).toBe(false);
	});

	test("ranking by shared-tag count (more overlap ranks first)", async () => {
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argv", "argparse", "argparse-integrity"],
			excludeIds: ["flux2:own-gotcha", "flux2:other"],
			topK: 10,
		});
		// mlx-review:argparse-private shares 3 tags → ranks above mlx-review:path-bug (0 shared).
		expect(r.cards[0]!.id).toBe("mlx-review:argparse-private");
		expect(r.cards[0]!.sharedTags.length).toBe(3);
	});

	test("topK truncates", async () => {
		const r = await retrieveRecords({ vaultPath: vault, tags: ["argv"], topK: 1 });
		expect(r.returned).toBe(1);
		expect(r.matched).toBeGreaterThanOrEqual(2);
	});

	test("digest is non-empty and names the matched card", async () => {
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse"],
			excludeIds: ["flux2:own-gotcha", "flux2:other"],
		});
		const digest = formatRetrieveDigest(r);
		expect(digest).toContain("mlx argparse private attrs");
		expect(digest).toContain("(graph:");
	});

	test("empty result digest is honest", async () => {
		const r = await retrieveRecords({ vaultPath: vault, tags: ["nonexistent-tag"], topK: 5 });
		expect(r.returned).toBe(0);
		expect(formatRetrieveDigest(r)).toContain("0 cross-workflow");
	});
});

describe("graphHealth", () => {
	beforeEach(async () => {
		await ingest(FLUX2_RECORDS, "workflow-jsonl:flux2");
		await ingest(MLX_RECORDS, "workflow-jsonl:mlx-review");
	});

	test("clean ingest → OK (no dead links, no MOC drift)", async () => {
		const h = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(h.cardCount).toBe(4);
		expect(h.deadLinks).toEqual([]);
		expect(h.mocMissing).toEqual([]);
		expect(h.mocStale).toEqual([]);
		expect(h.ok).toBe(true);
	});

	test("detects MOC drift when a card is added without re-ingest", async () => {
		// Hand-write a card the MOC doesn't know about.
		const cardPath = join(vault, FOLDER, "manual-unmoced-card.md");
		writeFileSync(
			cardPath,
			[
				"---",
				'id: "manual:unmoced"',
				"created: 2026-07-04",
				"tags: [zettel, gotcha, argv]",
				"---",
				"# manual unmoced card",
				"",
				"## 核心想法",
				"orphan detail.",
				"",
			].join("\n"),
		);
		const h = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(h.mocMissing).toContain("manual-unmoced-card");
		expect(h.ok).toBe(false);
	});

	test("prose [[...]] in a card body is NOT a dead link (slug filter)", async () => {
		// A card whose detail literally contains "[[...]]" (Python nested-list prose)
		// must not register as a dead link to a note named "...".
		await ingest(
			[rec({ id: "test:prose", title: "prose card", tags: ["argv"], detail: "nested list [[...]] here" })],
			"workflow-jsonl:prose",
		);
		const h = await graphHealth({ vaultPath: vault, folder: FOLDER, mocPath: MOC });
		expect(h.deadLinks.filter((d) => d.target === "...")).toEqual([]);
		expect(h.ok).toBe(true);
	});
});

describe("readActiveIds", () => {
	test("reads active ids and skips superseded/retired", () => {
		const kbPath = join(vault, "fake.knowledge.jsonl");
		writeFileSync(
			kbPath,
			[
				JSON.stringify({ id: "a:1", status: "active" }),
				JSON.stringify({ id: "a:2", status: "superseded" }),
				JSON.stringify({ id: "a:3", status: "retired" }),
				JSON.stringify({ id: "a:4", status: "active" }),
				"# comment line",
				"",
				"not-json",
			].join("\n"),
		);
		expect(readActiveIds(kbPath).sort()).toEqual(["a:1", "a:4"]);
	});

	test("missing file → []", () => {
		expect(readActiveIds(join(vault, "nope.jsonl"))).toEqual([]);
	});
});
