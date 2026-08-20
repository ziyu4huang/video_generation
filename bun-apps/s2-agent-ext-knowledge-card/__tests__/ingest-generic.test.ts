/**
 * Contract tests for the `generic` source family — the universal markdown adapter.
 *
 * `adaptGenericMarkdown` is what makes `zk_ingest` accept a RANDOM folder of `.md`
 * files (no hermes § entries, no auto-memory name/description frontmatter). These
 * exercise the adapter unit-level (frontmatter-rich/less, callout type-inference,
 * tag harvest, graceful null) plus the end-to-end convergence contract against a
 * real temp vault: valid card, idempotency, cross-source link.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRecords } from "../src/ingest.ts";
import { adaptGenericMarkdown, collectInputFiles } from "../src/adapters.ts";
import { slugify } from "../src/card-format.ts";
import type { KnowledgeRecord } from "../src/types.ts";
import { validateZettelNote } from "@repo/s2-agent-ext-obsidian";

let vault: string;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-ingest-generic-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

const FOLDER = "Zettelkasten/knowledge-graph";

/** Seed record helper (mirrors ingest.test.ts `rec`). */
function rec(over: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
	return {
		id: "test:base",
		type: "gotcha",
		title: "Base gotcha",
		detail: "Some detail about the gotcha.",
		tags: ["path-safety"],
		dimension: "correctness",
		confidence: 0.8,
		status: "active",
		superseded_by: null,
		...over,
	};
}

// ---------------------------------------------------------------------------
// adaptGenericMarkdown — unit level
// ---------------------------------------------------------------------------

describe("adaptGenericMarkdown", () => {
	test("frontmatter-rich md: H1 title, tags/type/created preserved, confidence 0.7", () => {
		const md = [
			"---",
			"tags: [react, hooks]",
			"type: reference",
			"created: 2026-07-01",
			"---",
			"",
			"# useEffect Cleanup",
			"",
			"Body about [[use-effect-deps]]. #frontend",
		].join("\n");
		const r = adaptGenericMarkdown(md, "notes/react.md")!;
		expect(r.title).toBe("useEffect Cleanup");
		expect(r.id).toBe("generic:useeffect-cleanup");
		expect(r.confidence).toBe(0.7);
		expect(r.dimension).toBe("reference"); // frontmatter `type` → dimension
		expect(r.tags).toContain("generic");
		expect(r.tags).toContain("react"); // frontmatter tag
		expect(r.tags).toContain("hooks");
		expect(r.tags).toContain("frontend"); // #hashtag
		expect(r.tags).toContain("use-effect-deps"); // [[wikilink]]
		expect(r.evidence?.first_seen).toBe("2026-07-01");
		expect(r.detail).toContain("Body about");
	});

	test("frontmatter-less md: filename-derived title/id, never crashes", () => {
		const md = "Just some prose with no frontmatter and no heading at all.";
		const r = adaptGenericMarkdown(md, "notes/random-note.md")!;
		expect(r.title).toBe("Random Note"); // dashes→spaces, title-cased
		expect(r.id).toBe("generic:random-note");
		expect(r.dimension).toBeNull(); // no frontmatter type/category/dimension
		expect(r.evidence).toBeUndefined(); // no created/date
		expect(r.confidence).toBe(0.7);
		expect(r.tags).toContain("generic");
		expect(r.tags).toContain("random-note"); // hyphenated filename token stays whole (split keeps `-`)
		expect(r.detail).toContain("Just some prose");
	});

	test("H1-less frontmatter-less md still yields a card (graceful over strict)", () => {
		const r = adaptGenericMarkdown("plain text body", "x/thing.md")!;
		expect(r).not.toBeNull();
		expect(r.title).toBe("Thing");
		expect(r.id).toBe("generic:thing");
	});

	test("callout type-inference: [!warning] → avoid, [!tip] → pattern", () => {
		const caution = [
			"# Dangerous Pattern",
			"",
			"> [!warning] This approach leaks memory.",
			"",
			"Avoid it.",
		].join("\n");
		expect(adaptGenericMarkdown(caution, "x/a.md")!.type).toBe("avoid");

		const tip = ["# Helpful Tip", "", "> [!tip] Cache your results."].join("\n");
		expect(adaptGenericMarkdown(tip, "x/b.md")!.type).toBe("pattern");
	});

	test("harvests body #hashtags AND [[wikilinks]] as cross-link tags", () => {
		const md = [
			"# Doc",
			"",
			"See [[some-note]] and [[other-note|alias]] plus #flux2 #argparse.",
		].join("\n");
		const r = adaptGenericMarkdown(md, "x/doc.md")!;
		expect(r.tags).toContain("some-note");
		expect(r.tags).toContain("other-note");
		expect(r.tags).toContain("flux2");
		expect(r.tags).toContain("argparse");
	});

	test("detail strips [[wiki-link]] brackets but keeps link text", () => {
		const md = "# Doc\n\nSee [[some-note]] and [[other-note|alias]].";
		const r = adaptGenericMarkdown(md, "x/doc.md")!;
		expect(r.detail).not.toContain("[[");
		expect(r.detail).toContain("some-note"); // bare target preserved
		expect(r.detail).toContain("alias"); // alias preserved
	});

	test("defensive: empty / whitespace files return null, never throw", () => {
		expect(adaptGenericMarkdown("", "x.md")).toBeNull();
		expect(adaptGenericMarkdown("   \n\n  ", "x.md")).toBeNull();
		expect(adaptGenericMarkdown(null as unknown as string, "x.md")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// collectInputFiles — generic directory expansion
// ---------------------------------------------------------------------------

describe("collectInputFiles (generic source)", () => {
	test("globs .md recursively, skips MEMORY.md/README.md and non-md", () => {
		const dir = mkdtempSync(join(tmpdir(), "kcard-generic-dir-"));
		try {
			mkdirSync(join(dir, "sub"), { recursive: true });
			writeFileSync(join(dir, "a.md"), "# A");
			writeFileSync(join(dir, "b.md"), "# B");
			writeFileSync(join(dir, "MEMORY.md"), "# index");
			writeFileSync(join(dir, "README.md"), "# readme");
			writeFileSync(join(dir, "c.txt"), "not md");
			writeFileSync(join(dir, "sub", "d.md"), "# D");

			const { files, skipped } = collectInputFiles([dir], {
				source: "generic",
				cwd: dir,
			});
			const names = files.map((f) => f.split("/").pop()!.replace(/\.md$/, ""));
			expect(names.sort()).toEqual(["a", "b", "sub/d".split("/").pop()!].sort()); // a, b, d
			expect(names).toContain("a");
			expect(names).toContain("b");
			expect(names).toContain("d");
			expect(names).not.toContain("MEMORY");
			expect(names).not.toContain("README");
			expect(files.every((f) => f.endsWith(".md"))).toBe(true);
			expect(skipped).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a direct .md file path passes through unchanged", () => {
		const dir = mkdtempSync(join(tmpdir(), "kcard-generic-file-"));
		try {
			const fp = join(dir, "single.md");
			writeFileSync(fp, "# Single");
			const { files } = collectInputFiles([fp], { source: "generic", cwd: dir });
			expect(files).toEqual([fp]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// ingestRecords end-to-end with generic records (the convergence contract)
// ---------------------------------------------------------------------------

describe("ingestRecords — generic source end-to-end", () => {
	test("a generic record becomes a valid zettel card in the convergence folder", async () => {
		const md = [
			"---",
			"tags: [testing]",
			"type: note",
			"---",
			"",
			"# Generic Doc Title",
			"",
			"Some arbitrary markdown body.",
		].join("\n");
		const record = adaptGenericMarkdown(md, "src/generic-doc.md")!;
		const s = await ingestRecords([record], {
			vaultPath: vault,
			source: "generic",
			sourceLabel: "generic:src",
		});
		expect(s.created).toBe(1);
		const basename = slugify(record.id); // generic-generic-doc-title → file name
		const card = readFileSync(join(vault, FOLDER, `${basename}.md`), "utf8");
		const v = validateZettelNote(card);
		expect(v.ok).toBe(true);
		expect(card).toContain("generic-doc-title"); // namespaced id in frontmatter
		expect(card).toContain("# Generic Doc Title"); // H1 title as the card heading
		expect(card).toContain("Some arbitrary markdown body"); // detail body
	});

	test("idempotency: re-ingesting the same generic file is a no-op (unchanged)", async () => {
		const record = adaptGenericMarkdown("# Stable Doc\n\nBody.", "x/stable-doc.md")!;
		const opts = { vaultPath: vault, source: "generic" as const, sourceLabel: "generic:x" };
		const first = await ingestRecords([record], opts);
		expect(first.created).toBe(1);
		const second = await ingestRecords([record], opts);
		expect(second.created).toBe(0);
		expect(second.unchanged).toBe(1);
		expect(second.updated).toBe(0);
	});

	test("cross-source link: a generic card links a workflow card via a shared tag", async () => {
		// 1. Seed a workflow gotcha sharing the `cleanup` concept tag.
		await ingestRecords(
			[
				rec({
					id: "cli:cleanup-rule",
					type: "gotcha",
					title: "Always clean up resources",
					tags: ["cleanup", "resources"],
					detail: "Release handles on every path.",
				}),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:cli" },
		);
		// 2. Ingest a generic doc that mentions #cleanup (harvested as a tag).
		const genericRec = adaptGenericMarkdown(
			"# Cleanup Pattern\n\nA note about #cleanup best practice.",
			"x/cleanup-pattern.md",
		)!;
		await ingestRecords([genericRec], {
			vaultPath: vault,
			source: "generic",
			sourceLabel: "generic:x",
		});
		const basename = slugify(genericRec.id);
		const card = readFileSync(join(vault, FOLDER, `${basename}.md`), "utf8");
		// The generic card must link across the source boundary to the workflow card.
		expect(card).toContain("[[cli-cleanup-rule]]");
	});
});
