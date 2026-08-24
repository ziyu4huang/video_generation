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

	test("tree walks the agg hierarchy on the md lane (reviewer F2: leaf parents inverted, agg ids normalized)", async () => {
		await seed();
		// Hand-write a 3-node agg chain the ingest path does not produce:
		// agg-L1-0 (parent agg:0:0 id form) → agg-L0-0 → leaf-alpha.
		const { writeFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(join(vault, FOLDER), { recursive: true });
		writeFileSync(
			join(vault, FOLDER, "agg-L0-0.md"),
			"---\nid: agg:0:0\nkind: derived-aggregation\nlayer: 0\nstatus: active\n---\n# Agg L0\n\n## 子節點\n- [[test-alpha]]\n",
		);
		writeFileSync(
			join(vault, FOLDER, "agg-L1-0.md"),
			"---\nid: agg:1:0\nkind: derived-aggregation\nparent: agg:0:0\nlayer: 1\nstatus: active\n---\n# Agg L1\n",
		);
		const r = await fsTree({ vaultPath: vault, client: downClient });
		expect(r.ok).toBe(true);
		const paths = r.entries.map((e) => e.path);
		// The L0 root renders, its leaf child inverts under it, and the L1
		// child's `parent: agg:0:0` id form resolves to the L0 stem.
		expect(paths).toContain(`${FOLDER}/agg-L0-0`);
		expect(paths).toContain(`${FOLDER}/test-alpha`);
		expect(paths).toContain(`${FOLDER}/agg-L1-0`);
	});
});

// ─── D27 default switch (hier-first + hydration + fallback) ─────────────────


const embedder = (async (texts: string[]) => texts.map(() => [1, 0, 0, 0])) as unknown as import("../src/semantic.ts").Embedder;

/** Wrap an inner fake with the freshness-gate answers (indexStatus + count).
 *  The gate (reviewer F1/F5 fix + ticket 02 fingerprint leg) requires: index
 *  present, embed_model match, cardCount === md file count, AND
 *  fingerprint === the LIVE vaultFingerprint of the fixture vault (computed
 *  for real — the stored value must be what a fresh rebuild would stamp).
 *  `stale` forces a count mismatch; `staleFingerprint` forces a fingerprint
 *  mismatch with the count still agreeing (the ticket-02 in-place-edit case). */
function freshClient(inner: (sql: string) => Promise<unknown>, opts: { stale?: boolean; staleFingerprint?: boolean; model?: string; mdCount?: number } = {}): SurrealClient {
	// STAMP AT CONSTRUCTION: a real index_meta row was written by a PAST
	// rebuild — the ticket-02 tests construct the client BEFORE mutating the
	// vault, so this frozen value is the pre-mutation fingerprint the gate
	// must disagree with. (Computing it at query time would chase the
	// mutation and always read fresh.)
	const stampedFp = vaultFingerprint(vault, FOLDER);
	return fakeClient(async <T>(sql: string) => {
		if (sql.includes("index_meta")) {
			return [{
				fingerprint: opts.staleFingerprint ? `${stampedFp}-stale` : stampedFp,
				embed_model: opts.model ?? "text-embedding-bge-m3",
			}] as unknown as T;
		}
		if (sql.includes("SELECT VALUE count()")) {
			const md = opts.mdCount ?? readdirSync(join(vault, FOLDER)).filter((n) => n.endsWith(".md")).length;
			return [{ count: opts.stale ? md + 1 : md }] as unknown as T;
		}
		return (await inner(sql)) as T;
	});
}

import { resolveCardEmbedModel } from "../src/semantic.ts";
import { vaultFingerprint } from "../src/surreal-index.ts";
import { readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";

describe("retrieveRecords D27 default switch (D36)", () => {
	test("hier-first hydrates leaf cards through the md path (RetrieveResult shape preserved)", async () => {
		await seed();
		const client = freshClient(async (sql: string) => {
			if (sql.includes("<|")) {
				// KNN lane: seed the alpha card (leaf) + a fake agg.
				return [
					{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: "agg-x", summary: "", sim: 0.9 },
				];
			}
			if (sql.includes("@@")) {
				return []; // no FTS hits
			}
			return []; // parent/stem expansion: none
		}, { model: resolveCardEmbedModel(undefined) });
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
		const client = freshClient(async (sql: string) => {
			if (sql.includes("<|")) {
				return [
					{ stem: "gone-card", path: `${FOLDER}/gone-card`, title: "Gone", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.9 },
					{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.8 },
				];
			}
			return [];
		}, { model: resolveCardEmbedModel(undefined) });
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
		const client = freshClient(async (sql: string) => {
			if (sql.includes("<|")) {
				return [
					{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.9 },
				];
			}
			return [];
		}, { model: resolveCardEmbedModel(undefined) });
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
		expect(r.trace?.hierUsed).toBe(true);
	});

	test("freshness gate (reviewer F1): card-count mismatch falls back to flat", async () => {
		await seed();
		let knnSeen = false;
		const client = freshClient(async (sql: string) => {
			if (sql.includes("<|")) {
				knnSeen = true;
				return [{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.9 }];
			}
			return [];
		}, { stale: true, model: resolveCardEmbedModel(undefined) });
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse"],
			queryText: "argparse flags",
			semantic: true,
			_hierClient: client,
			_testEmbedder: embedder,
		});
		// stale index (count mismatch) → the KNN lane is never consulted, flat answers
		expect(knnSeen).toBe(false);
		expect(r.cards.some((c) => c.id === "test:alpha")).toBe(true);
	});

	test("freshness gate (reviewer F5): embed-model mismatch falls back to flat", async () => {
		await seed();
		let knnSeen = false;
		const client = freshClient(async (sql: string) => {
			if (sql.includes("<|")) {
				knnSeen = true;
				return [{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.9 }];
			}
			return [];
		}, { model: "a-different-model" });
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse"],
			queryText: "argparse flags",
			semantic: true,
			_hierClient: client,
			_testEmbedder: embedder,
		});
		expect(knnSeen).toBe(false);
		expect(r.cards.some((c) => c.id === "test:alpha")).toBe(true);
	});
});

// ─── Ticket 02: content-aware freshness fingerprint (in-place-edit staleness) ─

describe("freshness gate fingerprint leg (ticket 02)", () => {
	/** Shared harness: a client whose index was stamped over the SEEDED vault,
	 *  with `mutate` applied AFTER stamping (freshClient freezes the
	 *  fingerprint at construction — the index never sees the mutation, the
	 *  gate must). Returns whether the hier lane was consulted. */
	async function gateAfter(mutate?: (v: string) => void): Promise<boolean> {
		await seed();
		let knnSeen = false;
		const client = freshClient(async (sql: string) => {
			if (sql.includes("<|")) {
				knnSeen = true;
				return [{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.9 }];
			}
			return [];
		}, { model: resolveCardEmbedModel(undefined) });
		if (mutate) mutate(vault);
		const r = await retrieveRecords({
			vaultPath: vault,
			tags: ["argparse"],
			queryText: "argparse flags",
			semantic: true,
			_hierClient: client,
			_testEmbedder: embedder,
		});
		// flat always answers; knnSeen is the hier-lane verdict
		expect(r.cards.length).toBeGreaterThan(0);
		return knnSeen;
	}

	test("identical tree: fingerprint matches, the hier lane serves", async () => {
		expect(await gateAfter()).toBe(true);
	});

	test("in-place edit (same file count): fingerprint flips → flat fallback", async () => {
		// THE ticket-02 case: count and model agree, only content changed.
		const served = await gateAfter((v) => {
			const p = join(v, FOLDER, "test-alpha.md");
			writeFileSync(p, readFileSync(p, "utf8").replace("Argparse", "Argparse EDITED"));
		});
		expect(served).toBe(false);
	});

	test("append (new card file): gate flips (count leg catches it too)", async () => {
		const served = await gateAfter((v) => {
			writeFileSync(join(v, FOLDER, "test-delta.md"), "---\nid: test:delta\ntype: gotcha\nstatus: active\n---\n# Delta\n");
		});
		expect(served).toBe(false);
	});

	test("delete: gate flips", async () => {
		const served = await gateAfter((v) => {
			unlinkSync(join(v, FOLDER, "test-gamma.md"));
		});
		expect(served).toBe(false);
	});

	test("rename (same content, new stem): gate flips", async () => {
		const served = await gateAfter((v) => {
			renameSync(join(v, FOLDER, "test-beta.md"), join(v, FOLDER, "test-beta-renamed.md"));
		});
		expect(served).toBe(false);
	});

	test("staleFingerprint with count still agreeing: flat (the fake-forces-it case)", async () => {
		await seed();
		let knnSeen = false;
		const client = freshClient(async (sql: string) => {
			if (sql.includes("<|")) {
				knnSeen = true;
				return [{ stem: "test-alpha", path: `${FOLDER}/test-alpha`, title: "Alpha gotcha", kind: "gotcha", is_leaf: true, parent: null, summary: "", sim: 0.9 }];
			}
			return [];
		}, { staleFingerprint: true, model: resolveCardEmbedModel(undefined) });
		const r = await retrieveRecords({
			vaultPath: vault, tags: ["argparse"], queryText: "argparse flags", semantic: true,
			_hierClient: client, _testEmbedder: embedder,
		});
		expect(knnSeen).toBe(false);
		expect(r.cards.length).toBeGreaterThan(0);
	});

	test("vaultFingerprint formula: mtime-free (D13) — re-writing IDENTICAL content does not flip it", async () => {
		await seed();
		const fp1 = vaultFingerprint(vault, FOLDER);
		// rewrite one file byte-identical (mtime changes, content does not)
		const p = join(vault, FOLDER, "test-alpha.md");
		writeFileSync(p, readFileSync(p, "utf8"));
		const fp2 = vaultFingerprint(vault, FOLDER);
		expect(fp2).not.toBeNull();
		expect(fp2).toBe(fp1);
	});

	test("vaultFingerprint: unreadable folder → null (gate treats as stale, never throws)", () => {
		expect(vaultFingerprint(vault, "does/not/exist")).toBeNull();
	});
});
