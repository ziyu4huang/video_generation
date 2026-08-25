/**
 * resource-index hermetic tests (effort 2026-08-25-kcard-resource-tier,
 * ticket 01) — pure read side, no Surreal, no network. The live scratch-db
 * rebuild/query round-trip lives in resource-index-live.test.ts.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildResourceRows,
	rebuildResourceIndex,
	resourceCreateStmt,
	resourceKnnQuery,
	resourceRecordKey,
	TIER_SIDEFILES,
} from "../src/resource-index.ts";
import type { ResourceIndexRow } from "../src/resource-index.ts";
import { stripLoneSurrogates } from "../src/surreal-index.ts";
import type { SurrealClient } from "@repo/s2-agent-core-interface";

/** Fake SurrealClient (reviewer m3/m4): captures every statement, answers
 *  query() from a scriptable handler. Cast-shaped, never a network call. */
function fakeClient(onQuery?: (sql: string, params?: unknown) => unknown): {
	client: SurrealClient;
	statements: string[];
} {
	const statements: string[] = [];
	const client = {
		namespace: "test_ns",
		database: "test_db",
		async query<T>(_sql?: string, _params?: unknown): Promise<T | null> {
			const sql = _sql ?? "";
			statements.push(sql);
			const out = onQuery?.(sql, _params);
			return (out === undefined ? [] : out) as T | null;
		},
	} as unknown as SurrealClient;
	return { client, statements };
}

// Deterministic embedder: 8-dim one-hot-ish hash vector — order-stable,
 // injectable, zero network (the _testEmbedder hermeticity contract).
const fakeEmbedder = async (texts: string[]): Promise<number[][]> =>
	texts.map((t) => {
		const v = new Array<number>(8).fill(0);
		for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 8] += 1;
		const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
		return v.map((x) => x / norm);
	});

let root: string;

function put(rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kcard-resource-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("buildResourceRows — walk", () => {
	test("indexes nested .md files; excludes dot-dirs and tier sidecars", async () => {
		put("pages/page-001.md", "# Page One\n\nBody one.");
		put("pages/page-002.md", "# Page Two\n\nBody two.");
		put("chapters/intro.md", "# Intro\n\nIntro body.");
		put("pages/.abstract.md", "# derived sidecar"); // tier sidecar — excluded
		put(".resource-semantic/cache.json", "{}"); // dot-dir — excluded
		put("notes.txt", "not markdown"); // non-md — excluded
		const built = await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		expect(built.rows.map((r) => r.uri).sort()).toEqual(["chapters/intro.md", "pages/page-001.md", "pages/page-002.md"]);
	});

	test("row shape: level 2, parent dirs, name from H1 (filename fallback), deterministic abstract", async () => {
		put("pages/page-001.md", "# PM Packet Header\n\nA PM Packet shall consist of the header. More text follows here.");
		const built = await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		const row = built.rows[0]!;
		expect(row.level).toBe(2);
		expect(row.parent).toBe("pages");
		expect(row.name).toBe("PM Packet Header");
		expect(row.abstract).toContain("A PM Packet shall consist of the header");
		expect(row.embed_model).toBe("fake-model");
		expect(row.vec).not.toBeNull();
	});

	test("root-level file → parent null; no-H1 file → name from filename stem", async () => {
		put("top.md", "Just prose, no heading. Second sentence.");
		const built = await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		expect(built.rows[0]!.parent).toBeNull();
		expect(built.rows[0]!.name).toBe("top");
	});

	test("tree discriminator defaults to basename, override wins", async () => {
		put("a.md", "# A\n\nBody.");
		expect((await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder })).tree)
			.toMatch(/^kcard-resource-/);
		expect((await buildResourceRows({ treePath: root, tree: "usb4", model: "fake-model", embedder: fakeEmbedder })).tree)
			.toBe("usb4");
	});
});

describe("buildResourceRows — fingerprint + delta cache", () => {
	test("fingerprint is content-only: stable across mtime changes, flips on edit", async () => {
		put("a.md", "# A\n\nBody.");
		put("b.md", "# B\n\nBody.");
		const r1 = await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		// touch mtimes only — fingerprint must not move (mtime-free, D13 shape)
		const t = new Date(Date.now() + 5000);
		utimesSync(join(root, "a.md"), t, t);
		const r2 = await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		expect(r2.fingerprint).toBe(r1.fingerprint);
		put("a.md", "# A\n\nEDITED body.");
		const r3 = await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		expect(r3.fingerprint).not.toBe(r1.fingerprint);
	});

	test("second run over an unchanged tree embeds ZERO files (all cache hits)", async () => {
		put("a.md", "# A\n\nBody.");
		put("b.md", "# B\n\nBody.");
		await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		const r2 = await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		expect(r2.embedded).toBe(0);
		expect(r2.cached).toBe(2);
	});

	test("single-file edit re-embeds ONLY that file (ticket-01 delta contract)", async () => {
		put("a.md", "# A\n\nBody.");
		put("b.md", "# B\n\nBody.");
		put("c.md", "# C\n\nBody.");
		await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		put("b.md", "# B\n\nEDITED.");
		const r2 = await buildResourceRows({ treePath: root, model: "fake-model", embedder: fakeEmbedder });
		expect(r2.embedded).toBe(1);
		expect(r2.cached).toBe(2);
	});

	test("cache is model-keyed: a model flip re-embeds everything", async () => {
		put("a.md", "# A\n\nBody.");
		await buildResourceRows({ treePath: root, model: "m1", embedder: fakeEmbedder });
		const r2 = await buildResourceRows({ treePath: root, model: "m2", embedder: fakeEmbedder });
		expect(r2.embedded).toBe(1);
	});

	test("embedder unavailable → rows still build with vec null, dim 0", async () => {
		put("a.md", "# A\n\nBody.");
		const built = await buildResourceRows({ treePath: root, model: "fake-model", embedder: undefined });
		expect(built.rows).toHaveLength(1);
		expect(built.rows[0]!.vec).toBeNull();
		expect(built.dim).toBe(0);
	});

	test("embedder failure mid-run degrades to partial vectors (never throws)", async () => {
		put("a.md", "# A\n\nBody.");
		put("b.md", "# B\n\nBody.");
		const failing = async (texts: string[]): Promise<number[][]> => {
			if (texts.length > 1) throw new Error("endpoint down");
			return fakeEmbedder(texts);
		};
		// 2 files, 1 batch → the single batch throws → all vecs null, no throw
		const built = await buildResourceRows({ treePath: root, model: "fake-model", embedder: failing });
		expect(built.rows).toHaveLength(2);
		expect(built.rows.every((r) => r.vec === null)).toBe(true);
	});
});

describe("record keys + constants", () => {
	test("resourceRecordKey is a legal sha-keyed identifier, distinct per tree+uri", () => {
		const k1 = resourceRecordKey("usb4", "pages/page-001.md");
		const k2 = resourceRecordKey("usb4", "pages/page-002.md");
		const k3 = resourceRecordKey("other", "pages/page-001.md");
		expect(k1).toMatch(/^resource:[0-9a-f]{16}$/);
		expect(k1).not.toBe(k2);
		expect(k1).not.toBe(k3);
	});

	test("tier sidecar names are exactly the two upstream OKF names", () => {
		expect([...TIER_SIDEFILES].sort()).toEqual([".abstract.md", ".overview.md"]);
	});
});

describe("KNN fallback lane (fake client, reviewer m3)", () => {
	test("combined tree+KNN predicate rejected → unfiltered over-fetch (k*5) + client-side tree filter + slice", async () => {
		const rows = [
			{ tree: "other", uri: "x.md", name: "X", abstract: "", level: 2, parent: null, sim: 0.9 },
			{ tree: "fixture", uri: "a.md", name: "A", abstract: "", level: 2, parent: null, sim: 0.8 },
			{ tree: "fixture", uri: "b.md", name: "B", abstract: "", level: 2, parent: null, sim: 0.7 },
		];
		let sawUnfiltered: string | null = null;
		const { client, statements } = fakeClient((sql) => {
			if (/AND vec <\|/.test(sql)) throw new Error("parse error"); // v3.2.3 rejects the combo
			if (/WHERE vec <\|/.test(sql)) {
				sawUnfiltered = sql;
				return rows;
			}
			return [];
		});
		const res = await resourceKnnQuery({ client, query: "anything", tree: "fixture", topK: 1, model: "m", embedder: fakeEmbedder });
		expect(res.semantic).toBe(true);
		expect(res.hits).toHaveLength(1);
		expect(res.hits[0]!.uri).toBe("a.md"); // other-tree row filtered, then sliced to topK
		expect(sawUnfiltered ?? "").toContain("<|5,100|>"); // k*5 over-fetch
		expect(statements.some((s) => /AND vec <\|/.test(s))).toBe(true); // primary attempted first
	});

	test("combined predicate accepted → no fallback round-trip", async () => {
		let combined = false;
		const { client } = fakeClient((sql) => {
			if (/AND vec <\|/.test(sql)) {
				combined = true;
				return [{ tree: "fixture", uri: "a.md", name: "A", abstract: "", level: 2, parent: null, sim: 0.8 }];
			}
			return [];
		});
		const res = await resourceKnnQuery({ client, query: "q", tree: "fixture", topK: 5, model: "m", embedder: fakeEmbedder });
		expect(combined).toBe(true);
		expect(res.hits[0]!.uri).toBe("a.md");
	});

	test("embedder down → semantic:false, zero statements issued", async () => {
		const { client, statements } = fakeClient(() => []);
		// a THROWING embedder (undefined would fall to the live default param)
		const down = async (): Promise<number[][]> => {
			throw new Error("embedding endpoint down");
		};
		const res = await resourceKnnQuery({ client, query: "q", embedder: down });
		expect(res.semantic).toBe(false);
		expect(res.hits).toHaveLength(0);
		expect(statements).toHaveLength(0);
	});
});

describe("card-lane isolation tripwire (fake client, reviewer m4)", () => {
	test("a full rebuild never issues a statement touching card / index_meta", async () => {
		put("a.md", "# A\n\nBody.");
		const { client, statements } = fakeClient((sql) => {
			if (/^SELECT fingerprint/.test(sql.trim())) return [{ fingerprint: "x", embed_model: "m", dim: 8 }];
			if (/SELECT VALUE count\(\)/.test(sql)) return [{ count: 0 }];
			return [];
		});
		await rebuildResourceIndex({ client, treePath: root, tree: "iso", model: "m", embedder: fakeEmbedder });
		expect(statements.length).toBeGreaterThan(0);
		// `\bcard\b` must not match `resource`/`resource_meta`; word boundaries
		// on both sides keep `kcard`/`cardinality` out only if bounded — spell it.
		const offenders = statements.filter((s) => /(^|[^_a-zA-Z:])card([^_a-zA-Z:]|$)|index_meta/.test(s));
		expect(offenders).toEqual([]);
	});

	test("M1 skip gate: a dim-0 meta stamp does NOT satisfy a dim-8 rebuild", async () => {
		put("a.md", "# A\n\nBody.");
		const { client } = fakeClient((sql) => {
			if (/^SELECT fingerprint/.test(sql.trim())) {
				// a previous vector-less build stamped fingerprint+model but dim 0
				return [{ fingerprint: "STALE", embed_model: "m", dim: 0 }];
			}
			if (/SELECT VALUE count\(\)/.test(sql)) return [{ count: 1 }];
			return [];
		});
		const r = await rebuildResourceIndex({ client, treePath: root, tree: "iso", model: "m", embedder: fakeEmbedder });
		// the fake's fingerprint never matches ("STALE"), so this rebuilds for
		// the fingerprint reason; the DIM leg is asserted by the matching-fp
		// variant below.
		expect(r.skipped).toBe(false);
	});

	test("M1 skip gate: matching fingerprint + dim → skip even when the file set is unchanged", async () => {
		put("a.md", "# A\n\nBody.");
		const built = await buildResourceRows({ treePath: root, tree: "iso2", model: "m", embedder: fakeEmbedder });
		const { client } = fakeClient((sql) => {
			if (/^SELECT fingerprint/.test(sql.trim())) {
				return [{ fingerprint: built.fingerprint, embed_model: built.embedModel, dim: built.dim }];
			}
			if (/SELECT VALUE count\(\)/.test(sql)) return [{ count: built.rows.length }];
			return [];
		});
		const r = await rebuildResourceIndex({ client, treePath: root, tree: "iso2", model: "m", embedder: fakeEmbedder });
		expect(r.skipped).toBe(true);
	});

	test("M1 skip gate: matching fingerprint but stale dim → rebuild (the embedder-down brick)", async () => {
		put("a.md", "# A\n\nBody.");
		const built = await buildResourceRows({ treePath: root, tree: "iso3", model: "m", embedder: fakeEmbedder });
		const { client } = fakeClient((sql) => {
			if (/^SELECT fingerprint/.test(sql.trim())) {
				// previous build stamped the SAME fingerprint but dim 0 (embedder was down)
				return [{ fingerprint: built.fingerprint, embed_model: built.embedModel, dim: 0 }];
			}
			if (/SELECT VALUE count\(\)/.test(sql)) return [{ count: built.rows.length }];
			return [];
		});
		const r = await rebuildResourceIndex({ client, treePath: root, tree: "iso3", model: "m", embedder: fakeEmbedder });
		expect(r.skipped).toBe(false);
	});
});

describe("lone-surrogate sanitation (2026-08-25 USB4 batch poisoning)", () => {
	test("stripLoneSurrogates keeps valid pairs, drops lone halves", () => {
		const pair = "𝑡"; // 𝑡 (mathematical italic t)
		expect(stripLoneSurrogates(`a${pair}b`)).toBe(`a${pair}b`);
		expect(stripLoneSurrogates("a\uD835b")).toBe("ab"); // lone high half
		expect(stripLoneSurrogates("a\uDC61b")).toBe("ab"); // lone low half
		expect(stripLoneSurrogates("plain ascii")).toBe("plain ascii");
	});

	test("resourceCreateStmt strips a cap-split pair; no \\ud8xx–\\udfxx escape is emitted", () => {
		// Same bug class as the card-lane test (surreal-index.test.ts): the
		// abstract slices in this file (resource-index.ts `slice(0, 1000)`)
		// are code-unit caps, so an IN-MEMORY split is the real shape — a
		// file-seeded surrogate can never reach this layer (utf8 decode maps
		// lone halves to U+FFFD on read; mutation-verified vacuous).
		const full = `${"y".repeat(999)}𝑡 trailing abstract text`; // pair straddles the 1000 cap
		const capped = full.slice(0, 1000);
		// Premise (self-verifying non-vacuousness): raw stringify WOULD emit
		// the escape SurrealDB rejects.
		expect(JSON.stringify(capped)).toMatch(/\\ud[89a-f]/i);
		const row = {
			tree: "sur",
			uri: "pages/math.md",
			level: 2,
			name: "Math",
			abstract: capped,
			vec: null,
			embed_model: "m",
			created: "2026-08-25T00:00:00Z",
			updated: "2026-08-25T00:00:00Z",
			parent: "pages",
		} satisfies ResourceIndexRow;
		const stmt = resourceCreateStmt("resource", row);
		expect(/\\ud[89a-f]/i.test(stmt)).toBe(false);
		expect(stmt).toContain("pages/math.md"); // untouched values survive
	});
});
