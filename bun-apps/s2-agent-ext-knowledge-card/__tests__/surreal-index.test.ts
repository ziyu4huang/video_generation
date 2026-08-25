/**
 * Unit tests for the SurrealDB index row-builder (kcard-parity ticket 07,
 * D9/D13/D21) — offline, deterministic (mock embedder, temp vault). The
 * live-server contract (shadow rebuild + swap, KNN/FTS lanes) is covered by
 * surreal-index-live.test.ts.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCardRows, cardRecordKey, createStmt } from "../src/surreal-index.ts";
import type { CardIndexRow } from "../src/surreal-index.ts";
import type { Embedder } from "../src/semantic.ts";

// MOCK.GUARD (see semantic.test.ts): pre-load the REAL obsidian and register a
// pass-through mock so a leaked global stub cannot break parseFrontmatter.
const _obsRealAbs = new URL("../../s2-agent-ext-obsidian/src/index.ts", import.meta.url).pathname;
const _obsReal: Record<string, unknown> = await import(_obsRealAbs);
mock.module("@repo/s2-agent-ext-obsidian", () => ({ ..._obsReal }));

let vault: string;
const FOLDER = "Zettelkasten/knowledge-graph";

const mockEmbedder: Embedder = async (texts) =>
	texts.map((t) => {
		const v = [0.1, 0.2, 0.3, 0.4];
		// deterministic per-text jitter so vectors differ but stay simple
		v[0] += (t.length % 7) / 100;
		return v;
	});

function leaf(name: string, body: string, fm: Record<string, string | number> = {}): void {
	const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
	writeFileSync(
		join(vault, FOLDER, `${name}.md`),
		[`---`, ...fmLines, `---`, ``, `# ${name}`, ``, body, ``].join("\n"),
		"utf8",
	);
}

function agg(name: string, children: string[], fm: Record<string, string | number> = {}): void {
	writeFileSync(
		join(vault, FOLDER, `${name}.md`),
		[
			"---",
			`id: "agg:${fm.layer ?? 0}:0"`,
			'created: "auto"',
			"tags: [zettel, derived-aggregation]",
			"kind: derived-aggregation",
			`summary: "agg summary ${name}"`,
			`parent: ${fm.parent ?? "null"}`,
			"entities: [e1]",
			"sources: [s1]",
			`layer: ${fm.layer ?? 0}`,
			"clusterSize: 2",
			"generated: true",
			"---",
			"",
			`# ${name}`,
			"",
			"## 摘要",
			"",
			`summary of ${name}`,
			"",
			"## 子節點",
			"",
			...children.map((c) => `- [[${c}]]`),
			"",
		].join("\n"),
		"utf8",
	);
}

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-surreal-index-"));
	mkdirSync(join(vault, FOLDER), { recursive: true });
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

// Ticket-02 receipt follow-up (measured 2026-08-25 on the live 61-card copy):
// a DIRECTORY named *.md made buildCardRows THROW EISDIR — getCardEmbeddings
// pre-read every *.md entry (semantic.ts) BEFORE the guarded per-file loop
// below, so the documented read-skip ("unreadable → skipped, absent from
// both rows and fingerprint") was unreachable. With the semantic-side guard,
// the build now degrades exactly as the comment claims.
test("a DIRECTORY named *.md degrades to skipped — not a throw (EISDIR guard)", async () => {
	leaf("real", "real body text");
	mkdirSync(join(vault, FOLDER, "zz-eisdir.md"));
	const r = await buildCardRows({ vaultPath: vault, folder: FOLDER, embedder: mockEmbedder });
	expect(r.skipped).toContain("zz-eisdir.md");
	expect(r.rows.map((x) => x.stem)).toEqual(["real"]);
	// the dir is absent from the fingerprint too (readable files only)
	const names = readdirSync(join(vault, FOLDER)).filter((n) => n.endsWith(".md") && n !== "zz-eisdir.md");
	expect(r.rows.length).toBe(names.length);
});

describe("buildCardRows", () => {
	test("leaf parents come from INVERTED agg child links; agg parents from frontmatter", async () => {
		leaf("leaf-a", "alpha body");
		leaf("leaf-b", "beta body");
		agg("agg-L0-0", ["leaf-a", "leaf-b"], { layer: 0, parent: '"agg:1:0"' });
		agg("agg-L1-0", ["agg-L0-0"], { layer: 1, parent: "null" });
		const { rows } = await buildCardRows({ vaultPath: vault, folder: FOLDER, embedder: mockEmbedder });
		const by = new Map(rows.map((r) => [r.stem, r]));
		expect(by.get("leaf-a")!.parent).toBe("agg-L0-0");
		expect(by.get("leaf-b")!.parent).toBe("agg-L0-0");
		expect(by.get("agg-L0-0")!.parent).toBe("agg-L1-0");
		expect(by.get("agg-L1-0")!.parent).toBeNull();
		expect(by.get("agg-L0-0")!.is_leaf).toBe(false);
		expect(by.get("agg-L0-0")!.layer).toBe(0);
	});

	test("kind mirrors frontmatter type → record_type → 'pattern' (D15)", async () => {
		leaf("leaf-typed", "body", { type: "event" });
		leaf("leaf-legacy", "body", { record_type: "gotcha" });
		leaf("leaf-plain", "body");
		agg("agg-L0-0", ["leaf-typed"]);
		const { rows } = await buildCardRows({ vaultPath: vault, folder: FOLDER, embedder: mockEmbedder });
		const by = new Map(rows.map((r) => [r.stem, r]));
		expect(by.get("leaf-typed")!.kind).toBe("event");
		expect(by.get("leaf-legacy")!.kind).toBe("gotcha");
		expect(by.get("leaf-plain")!.kind).toBe("pattern");
		expect(by.get("agg-L0-0")!.kind).toBe("derived-aggregation");
	});

	test("fingerprint: content-hash based (stable across mtime changes, differs on edit)", async () => {
		leaf("leaf-a", "stable body");
		agg("agg-L0-0", ["leaf-a"]);
		const first = await buildCardRows({ vaultPath: vault, folder: FOLDER, embedder: mockEmbedder });
		// touch (mtime changes) — fingerprint must NOT change (D13: hash, not mtime)
		writeFileSync(join(vault, FOLDER, "leaf-a.md"), readFileSync(join(vault, FOLDER, "leaf-a.md"), "utf8"), "utf8");
		const touched = await buildCardRows({ vaultPath: vault, folder: FOLDER, embedder: mockEmbedder });
		expect(touched.fingerprint).toBe(first.fingerprint);
		// content change → different fingerprint
		leaf("leaf-a", "edited body");
		const edited = await buildCardRows({ vaultPath: vault, folder: FOLDER, embedder: mockEmbedder });
		expect(edited.fingerprint).not.toBe(first.fingerprint);
	});

	test("vectors attach from the embedder cache lane; dim observed; warm cache survives a down embedder; fresh vault degrades to null", async () => {
		leaf("leaf-a", "body");
		agg("agg-L0-0", ["leaf-a"]);
		const withVec = await buildCardRows({ vaultPath: vault, folder: FOLDER, embedder: mockEmbedder });
		expect(withVec.dim).toBe(4);
		expect(withVec.rows.every((r) => r.vec !== null && r.embed_model !== null)).toBe(true);
		// D13 reuse: with a warm model-keyed cache, a DOWN embedder still serves
		// vectors — unchanged cards embed zero times.
		const broken: Embedder = async () => {
			throw new Error("endpoint down");
		};
		const warmCache = await buildCardRows({ vaultPath: vault, folder: FOLDER, embedder: broken });
		expect(warmCache.rows.every((r) => r.vec !== null)).toBe(true);
		// fresh vault, no cache, down embedder → vec nulls (KNN lane degrades)
		const fresh = mkdtempSync(join(tmpdir(), "kcard-surreal-index-"));
		try {
			mkdirSync(join(fresh, FOLDER), { recursive: true });
			writeFileSync(join(fresh, FOLDER, "leaf-a.md"), "---\n---\n# leaf-a\nbody\n");
			const noVec = await buildCardRows({ vaultPath: fresh, folder: FOLDER, embedder: broken });
			expect(noVec.rows.every((r) => r.vec === null && r.embed_model === null)).toBe(true);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	test("subfolders (_archive) are not indexed", async () => {
		leaf("leaf-a", "body");
		mkdirSync(join(vault, FOLDER, "_archive"));
		writeFileSync(join(vault, FOLDER, "_archive", "old.md"), "---\n---\n# old\n");
		const { rows } = await buildCardRows({ vaultPath: vault, folder: FOLDER, embedder: mockEmbedder });
		expect(rows.map((r) => r.stem)).toEqual(["leaf-a"]);
	});
});

describe("cardRecordKey", () => {
	test("stable, legal identifier, independent of exotic stems", () => {
		const weird = "`Flux2 Scene` 佈局";
		expect(cardRecordKey(weird)).toBe(cardRecordKey(weird));
		expect(cardRecordKey(weird)).toMatch(/^card:[0-9a-f]{16}$/);
		expect(cardRecordKey(weird)).not.toBe(cardRecordKey("other"));
	});
});

describe("lone-surrogate sanitation — card lane (2026-08-25 USB4 batch poisoning)", () => {
	// A lone UTF-16 surrogate reaching JSON.stringify inside a SurrealQL
	// CREATE emits a \uD8xx escape SurrealDB rejects ("not a valid character
	// code") — poisoning the whole /sql batch and leaving the card index
	// stale. The production shape is an IN-MEMORY cap split (extractor.ts
	// slices summaries by UTF-16 code unit), so the test builds the row
	// directly: a file-seeded surrogate can never reach this layer (utf8
	// decode maps lone halves to U+FFFD on read — mutation-verified: a
	// file-based rebuild test passes with the strip reverted, i.e. vacuous).
	test("createStmt strips a cap-split pair; no \\ud8xx–\\udfxx escape is emitted", () => {
		const full = `${"x".repeat(1999)}𝑡 trailing summary text`; // pair straddles the 2000 cap
		const capped = full.slice(0, 2000); // the extractor's code-unit cap
		// Premise (self-verifying non-vacuousness): raw stringify WOULD emit
		// the escape — this is exactly what SurrealDB rejects.
		expect(JSON.stringify(capped)).toMatch(/\\ud[89a-f]/i);
		expect(/[\uD800-\uDBFF]$/.test(capped)).toBe(true); // the cap split the pair
		const row = {
			stem: "mathy",
			path: `${FOLDER}/mathy`,
			title: "Mathy",
			summary: capped,
			body: capped,
			is_leaf: true,
			layer: null,
			parent: null,
			entities: ["valid-entity", "e\uDC61"], // lone LOW half in the array lane
			kind: "note",
			vec: null,
			embed_model: "m",
		} satisfies CardIndexRow;
		const stmt = createStmt("card", row);
		// All surrogate escapes are \ud8xx–\udfxx (D + 8-F); JSON.stringify
		// never escapes a VALID pair, so this scan has no false-positive class.
		expect(/\\ud[89a-f]/i.test(stmt)).toBe(false);
		expect(stmt).toContain("valid-entity"); // untouched strings survive
	});
});
