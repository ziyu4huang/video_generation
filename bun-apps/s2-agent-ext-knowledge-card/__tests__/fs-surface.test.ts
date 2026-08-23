/**
 * Ticket 05 (D32–D36) tests: the FS-style read surface (fs-surface.ts — md
 * lane) and the D27 default switch inside retrieveRecords (hier-first with
 * hydration, flat fallback, escape hatches).
 *
 * Everything deterministic: the hier lane runs against a FAKE SurrealClient
 * (dispatch on SQL shape) + injected embedder; the fs ops run on the md
 * fallback lane (no Surreal) — the index lane is covered by the live tests
 * (surreal-index-live.test.ts pattern, skipped when the service is down).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRecords } from "../src/ingest.ts";
import { retrieveRecords } from "../src/retrieve.ts";
import { fsLs, fsTree, fsFind, fsGrep, fsStat } from "../src/fs-surface.ts";
import type { KnowledgeRecord } from "../src/types.ts";
import type { SurrealClient } from "@repo/s2-agent-core-interface";

let vault: string;
const FOLDER = "Zettelkasten/knowledge-graph";

function rec(over: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
	return {
		id: "test:alpha",
		type: "gotcha",
		title: "Alpha gotcha",
		detail: "The argparse parser silently swallows unknown flags.",
		tags: ["argparse"],
		dimension: "correctness",
		confidence: 0.8,
		status: "active",
		superseded_by: null,
		...over,
	};
}

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-fs-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

async function seed() {
	await ingestRecords(
		[
			rec({ id: "test:alpha", title: "Alpha gotcha", type: "gotcha", detail: "Argparse swallows unknown flags.", tags: ["argparse"] }),
			rec({ id: "test:beta", title: "Beta lever", type: "lever", detail: "Seed everything for reproducibility.", tags: ["seed"] }),
			rec({ id: "test:gamma", title: "Gamma event", type: "event", detail: "Model swap decided on 2026-08-23.", tags: ["model"] }),
		],
		{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "test", folder: FOLDER },
	);
}

// ─── fs ops (md lane — hermetic: the injected client throws, forcing the
// md fallback; a live Surreal on :8000 must NEVER leak into unit tests) ──────

type QueryFn = SurrealClient["query"];

function fakeClient(query: QueryFn): SurrealClient {
	return { query } as unknown as SurrealClient;
}

const downClient = fakeClient(async <T>(_sql: string) => {
	throw new Error("unit-test md lane");
});

describe("fs-surface (md fallback lane)", () => {
	test("ls root lists cards + the virtual type dir", async () => {
		await seed();
		const r = await fsLs({ vaultPath: vault, client: downClient });
		expect(r.ok).toBe(true);
		expect(r.lane).toBe("md");
		expect(r.scanned).toBe(3);
		expect(r.entries[0]!.path).toBe("type/");
		const paths = r.entries.map((e) => e.path);
		expect(paths.some((p) => p.startsWith(`${FOLDER}/test-alpha`))).toBe(true);
	});

	test("ls type/<kind> filters by the D18 discriminator", async () => {
		await seed();
		const r = await fsLs({ vaultPath: vault, client: downClient, path: "type/event" });
		expect(r.ok).toBe(true);
		expect(r.scanned).toBe(1);
		expect(r.entries[0]!.kind).toBe("event");
	});

	test("ls type/<unknown-kind> fails with the known-kind list", async () => {
		await seed();
		const r = await fsLs({ vaultPath: vault, client: downClient, path: "type/nope" });
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("unknown kind");
	});

	test("find substring + wildcard + type filter", async () => {
		await seed();
		expect((await fsFind({ vaultPath: vault, client: downClient, pattern: "alpha" })).entries.length).toBe(1);
		expect((await fsFind({ vaultPath: vault, client: downClient, pattern: "test-*" })).entries.length).toBe(3);
		expect((await fsFind({ vaultPath: vault, client: downClient, pattern: "*", type: "lever" })).entries.length).toBe(1);
	});

	test("grep matches body prose (md lane)", async () => {
		await seed();
		const r = await fsGrep({ vaultPath: vault, client: downClient, query: "reproducibility" });
		expect(r.ok).toBe(true);
		expect(r.entries.map((e) => e.path)).toContain(`${FOLDER}/test-beta`);
	});

	test("stat one card, tier promotes to overview", async () => {
		await seed();
		const l0 = await fsStat({ vaultPath: vault, client: downClient, path: `${FOLDER}/test-alpha` });
		expect(l0.ok).toBe(true);
		const l1 = await fsStat({ vaultPath: vault, client: downClient, path: `${FOLDER}/test-alpha`, tier: "overview" });
		expect(l1.ok).toBe(true);
		expect(l1.entries[0]!.text.length).toBeGreaterThanOrEqual(l0.entries[0]!.text.length);
	});

	test("tree returns the agg roots (or an empty-but-ok tree)", async () => {
		await seed();
		const r = await fsTree({ vaultPath: vault, client: downClient });
		expect(r.ok).toBe(true);
	});
});

// ─── D27 default switch (hier-first + hydration + fallback) ─────────────────


const embedder = (async (texts: string[]) => texts.map(() => [1, 0, 0, 0])) as unknown as import("../src/semantic.ts").Embedder;

describe("retrieveRecords D27 default switch (D36)", () => {
	test("hier-first hydrates leaf cards through the md path (RetrieveResult shape preserved)", async () => {
		await seed();
		const client = fakeClient(async <T>(sql: string) => {
			if (sql.includes("<|")) {
				// KNN lane: seed the alpha card (leaf) + a fake agg.
				return [
					{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: "agg-x", summary: "", sim: 0.9 },
				] as unknown as T;
			}
			if (sql.includes("@@")) {
				return [] as unknown as T; // no FTS hits
			}
			return [] as unknown as T; // parent/stem expansion: none
		});
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse"],
			queryText: "argparse flags",
			semantic: true,
			_hierClient: client,
			_testEmbedder: embedder,
		});
		expect(r.count).toBe(1);
		expect(r.cards[0]!.id).toBe("test:alpha");
		expect(r.cards[0]!.tiers).toBeDefined();
		expect(typeof r.digest).toBe("string");
		expect(r.digest).toContain("Alpha gotcha");
		// shape parity: every RetrieveResult contract field present
		expect(r.folder).toBe(FOLDER);
		expect(typeof r.scanned).toBe("number");
		expect(typeof r.excluded).toBe("number");
	});

	test("hier failure (ok:false) falls through to the flat path", async () => {
		await seed();
		const client = fakeClient(async <T>(_sql: string) => {
			throw new Error("surreal down");
		});
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse"],
			queryText: "argparse flags",
			semantic: true,
			_hierClient: client,
			_testEmbedder: embedder,
		});
		// flat lane answered (the tag-matched card is present; the degenerate
		// fake embedder may union extra cards via the old semantic blend — the
		// assertion is FALLBACK HAPPENED, not exact ranking)
		expect(r.count).toBeGreaterThanOrEqual(1);
		expect(r.cards.some((c) => c.id === "test:alpha")).toBe(true);
	});

	test("hier:false forces the flat path even when hier would fire", async () => {
		await seed();
		let called = false;
		const client = fakeClient(async <T>(sql: string) => {
			called = true;
			return [] as unknown as T;
		});
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse"],
			queryText: "argparse flags",
			semantic: true,
			hier: false,
			_hierClient: client,
			_testEmbedder: embedder,
		});
		expect(called).toBe(false);
		expect(r.count).toBeGreaterThanOrEqual(1);
	});

	test("KCARD_HIER_DEFAULT=0 env disables the hier lane", async () => {
		await seed();
		let called = false;
		const client = fakeClient(async <T>(_sql: string) => {
			called = true;
			return [] as unknown as T;
		});
		const prev = process.env.KCARD_HIER_DEFAULT;
		process.env.KCARD_HIER_DEFAULT = "0";
		try {
			await retrieveRecords({
				vaultPath: vault,
				tags: ["argparse"],
				queryText: "argparse flags",
				semantic: true,
				_hierClient: client,
				_testEmbedder: embedder,
			});
		} finally {
			if (prev === undefined) delete process.env.KCARD_HIER_DEFAULT;
			else process.env.KCARD_HIER_DEFAULT = prev;
		}
		expect(called).toBe(false);
	});

	test("stale index stems fail hydration and are counted excluded, not surfaced", async () => {
		await seed();
		const client = fakeClient(async <T>(sql: string) => {
			if (sql.includes("<|")) {
				return [
					{ stem: "gone-card", path: `${FOLDER}/gone-card`, title: "Gone", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.9 },
					{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.8 },
				] as unknown as T;
			}
			return [] as unknown as T;
		});
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse"],
			queryText: "argparse flags",
			semantic: true,
			_hierClient: client,
			_testEmbedder: embedder,
		});
		expect(r.count).toBe(1);
		expect(r.cards[0]!.id).toBe("test:alpha");
		expect(r.excluded).toBe(1);
	});

	test("type filter reaches the flat lane (D18 flat-side completion)", async () => {
		await seed();
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: [], // no tags → bodyMatch off → nothing matches; use tags instead below
			tier: "abstract",
		});
		expect(r.count).toBe(0);
		const r2 = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse", "seed", "model"],
			type: "lever",
		});
		expect(r2.count).toBe(1);
		expect(r2.cards[0]!.id).toBe("test:beta");
	});

	test("trace source is 'hierarchical' on the hier lane", async () => {
		await seed();
		const client = fakeClient(async <T>(sql: string) => {
			if (sql.includes("<|")) {
				return [
					{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.9 },
				] as unknown as T;
			}
			return [] as unknown as T;
		});
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse"],
			queryText: "argparse flags",
			semantic: true,
			includeTrace: true,
			_hierClient: client,
			_testEmbedder: embedder,
		});
		expect(r.trace?.cards[0]!.source).toBe("hierarchical");
	});
});
