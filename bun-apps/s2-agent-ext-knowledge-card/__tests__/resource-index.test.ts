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
	resourceRecordKey,
	TIER_SIDEFILES,
} from "../src/resource-index.ts";

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
