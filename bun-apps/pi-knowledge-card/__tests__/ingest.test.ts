/**
 * Contract tests for the deterministic knowledge-graph ingest primitive.
 *
 * These exercise the library end-to-end against a real temp vault (no mocks):
 * parse → ingest → validate cards → dedup → cross-source link → MOC. The
 * graph-density claim (the whole point of convergence) is asserted by feeding
 * records from TWO different sources with overlapping tags and checking the
 * edges actually form across the source boundary.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ingestRecords,
	parseKnowledgeJsonl,
	adaptAutoMemoryMarkdown,
	slugify,
	extractDate,
	formatSummary,
	type KnowledgeRecord,
} from "../src/ingest.ts";
import { validateZettelNote } from "pi-obsidian/extensions/obsidian.ts";

let vault: string;

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
	vault = mkdtempSync(join(tmpdir(), "kcard-ingest-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

const FOLDER = "Zettelkasten/knowledge-graph";

describe("parseKnowledgeJsonl", () => {
	test("parses well-formed lines + skips blanks/comments", () => {
		const txt = [
			JSON.stringify(rec({ id: "a:1", title: "A1" })),
			"",
			"# a comment",
			JSON.stringify(rec({ id: "a:2", title: "A2" })),
		].join("\n");
		const { records, parseErrors } = parseKnowledgeJsonl(txt);
		expect(records.map((r) => r.id)).toEqual(["a:1", "a:2"]);
		expect(parseErrors).toEqual([]);
	});

	test("collects per-line parse errors without throwing", () => {
		const txt = [
			"not json at all",
			JSON.stringify({ id: "x:1", type: "lever", title: "ok", detail: "d", tags: [], dimension: null, confidence: 1, status: "active", superseded_by: null }),
			JSON.stringify({ type: "lever" }), // missing id
			JSON.stringify({ id: "x:2" }), // missing title
		].join("\n");
		const { records, parseErrors } = parseKnowledgeJsonl(txt);
		expect(records.map((r) => r.id)).toEqual(["x:1"]);
		expect(parseErrors.length).toBe(3);
		expect(parseErrors[0]!.reason).toMatch(/JSON parse/);
		expect(parseErrors[1]!.reason).toMatch(/missing\/empty `id`/);
		expect(parseErrors[2]!.reason).toMatch(/missing\/empty `title`/);
	});

	test("coerces missing optional fields to safe defaults", () => {
		const { records } = parseKnowledgeJsonl(
			JSON.stringify({ id: "x:1", title: "T" }),
		);
		expect(records[0]).toMatchObject({
			type: "pattern",
			tags: [],
			status: "active",
			confidence: 0,
			superseded_by: null,
			dimension: null,
		});
	});
});

describe("adaptAutoMemoryMarkdown", () => {
	test("parses a memory topic file into a record", () => {
		const md = [
			"---",
			"name: pr-merge-sop",
			'description: "PR SOP for the multi-worktree repo"',
			"metadata:",
			"  type: feedback",
			"---",
			"",
			"PR merge standard flow. See [[git-pr-workflow-not-direct-main-push]].",
			"",
			"**Why:** concurrent sessions.",
		].join("\n");
		const rec = adaptAutoMemoryMarkdown(md);
		expect(rec).not.toBeNull();
		expect(rec!.id).toBe("auto-memory:pr-merge-sop");
		expect(rec!.title).toBe("PR SOP for the multi-worktree repo");
		expect(rec!.dimension).toBe("feedback");
		expect(rec!.tags).toContain("auto-memory");
		expect(rec!.tags).toContain("feedback");
		expect(rec!.tags).toContain("git-pr-workflow-not-direct-main-push"); // [[link]] harvested as tag
		expect(rec!.confidence).toBe(1);
		expect(rec!.detail).toContain("PR merge standard flow");
	});

	test("returns null for a non-memory file (no name/description)", () => {
		expect(adaptAutoMemoryMarkdown("# just a heading\nbody")).toBeNull();
		expect(
			adaptAutoMemoryMarkdown("---\nname: x\n---\nbody"), // missing description
		).toBeNull();
	});

	test("auto-memory + workflow records converge + link in one vault", async () => {
		// Source A: workflow-jsonl record about a git-pr gotcha.
		await ingestRecords(
			[
				rec({
					id: "flux2:git-pr-direct-push",
					type: "gotcha",
					title: "Never push main directly",
					tags: ["git-pr-workflow-not-direct-main-push", "git"],
					detail: "Always use a branch + PR.",
				}),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:flux2" },
		);
		// Source B: auto-memory record sharing the [[git-pr-workflow...]] concept.
		const memRec = adaptAutoMemoryMarkdown(
			[
				"---",
				"name: pr-merge-sop",
				'description: "PR SOP for the multi-worktree repo"',
				"metadata:",
				"  type: feedback",
				"---",
				"See [[git-pr-workflow-not-direct-main-push]].",
			].join("\n"),
		)!;
		const s2 = await ingestRecords([memRec], {
			vaultPath: vault,
			source: "auto-memory",
			sourceLabel: "auto-memory:pr-merge-sop",
		});
		expect(s2.created).toBe(1);
		// The two cards share the `git-pr-workflow-not-direct-main-push` tag →
		// a cross-source edge must exist in BOTH directions.
		const memCard = readFileSync(join(vault, FOLDER, "auto-memory-pr-merge-sop.md"), "utf8");
		expect(memCard).toContain("[[flux2-git-pr-direct-push]]");
		await ingestRecords(
			[
				rec({
					id: "flux2:git-pr-direct-push",
					type: "gotcha",
					title: "Never push main directly",
					tags: ["git-pr-workflow-not-direct-main-push", "git"],
					detail: "Always use a branch + PR.",
				}),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:flux2" },
		);
		const fluxCard = readFileSync(join(vault, FOLDER, "flux2-git-pr-direct-push.md"), "utf8");
		expect(fluxCard).toContain("[[auto-memory-pr-merge-sop]]");
	});
});

describe("slugify + extractDate", () => {
	test("slug collapses namespace separators to dashes", () => {
		expect(slugify("ltx:cfg-scale-7-lever")).toBe("ltx-cfg-scale-7-lever");
		expect(slugify("flux2:path/injection")).toBe("flux2-path-injection");
	});
	test("extractDate handles the 3 workflow timestamp formats", () => {
		expect(extractDate("20260620_091118")).toBe("2026-06-20");
		expect(extractDate("2026-06-14T22-47-40")).toBe("2026-06-14");
		expect(extractDate("2026-06-23T22:34:02Z")).toBe("2026-06-23");
		expect(extractDate(undefined, "20260101")).toBe("2026-01-01");
		expect(extractDate("garbage")).toBe("");
	});
});

describe("ingestRecords — single source", () => {
	test("creates one card per record that passes zettel validation", async () => {
		const summary = await ingestRecords(
			[rec({ id: "flux2:argv-injection", title: "Reject leading-dash argv" })],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:flux2" },
		);
		expect(summary.created).toBe(1);
		expect(summary.total).toBe(1);
		const cardPath = join(vault, FOLDER, "flux2-argv-injection.md");
		expect(existsSync(cardPath)).toBe(true);
		const content = readFileSync(cardPath, "utf8");
		const v = validateZettelNote(content); // frontmatter-only (no idx)
		expect(v.ok).toBe(true);
		// Canonical id + provenance preserved in frontmatter (the colon-bearing
		// values are YAML-quoted; stripScalar round-trips them on re-read).
		expect(content).toContain("flux2:argv-injection");
		expect(content).toMatch(/source_id:.*flux2:argv-injection/);
		expect(content).toContain("record_type: gotcha");
		expect(content).toMatch(/source:.*workflow-jsonl:flux2/);
		expect(content).toMatch(/tags: \[zettel, gotcha, path-safety/);
	});

	test("regenerates a MOC indexing every card", async () => {
		await ingestRecords(
			[
				rec({ id: "a:lever", type: "lever", title: "L" }),
				rec({ id: "a:gotcha", type: "gotcha", title: "G" }),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:a" },
		);
		const moc = join(vault, "Tags/Knowledge Graph.md");
		expect(existsSync(moc)).toBe(true);
		const mocText = readFileSync(moc, "utf8");
		expect(mocText).toContain("## gotcha");
		expect(mocText).toContain("## lever");
		expect(mocText).toContain("[[a-gotcha]]");
		expect(mocText).toContain("[[a-lever]]");
	});
});

describe("ingestRecords — idempotency + dedup", () => {
	test("re-ingesting the same record is a no-op (unchanged)", async () => {
		const opts = { vaultPath: vault, source: "workflow-jsonl" as const, sourceLabel: "s" };
		const r = rec({ id: "x:stable", title: "Stable" });
		const s1 = await ingestRecords([r], opts);
		expect(s1.created).toBe(1);
		const s2 = await ingestRecords([r], opts);
		expect(s2.created).toBe(0);
		expect(s2.updated).toBe(0);
		expect(s2.unchanged).toBe(1);
	});

	test("changing a record updates the same file in place (no duplicate)", async () => {
		const opts = { vaultPath: vault, source: "workflow-jsonl" as const, sourceLabel: "s" };
		await ingestRecords([rec({ id: "x:upd", title: "Old title", detail: "old" })], opts);
		const s2 = await ingestRecords([rec({ id: "x:upd", title: "New title", detail: "new" })], opts);
		expect(s2.updated).toBe(1);
		expect(s2.created).toBe(0);
		const files = readdirSync(join(vault, FOLDER));
		expect(files.filter((f) => f.startsWith("x-upd")).length).toBe(1);
	});
});

describe("ingestRecords — cross-source graph (the convergence payoff)", () => {
	test("cards from two sources with overlapping tags get linked across the boundary", async () => {
		// Source 1: flux2 learned an argv-injection gotcha.
		await ingestRecords(
			[
				rec({
					id: "flux2:argv-injection",
					type: "gotcha",
					title: "Reject leading-dash argv (flux2)",
					tags: ["path-safety", "argv-injection"],
					detail: "flux2 path validation bypass",
				}),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:flux2" },
		);
		// Source 2: krea2 learned the SAME class of gotcha (different id, shared tags).
		// Re-ingest the whole folder so links recomputed across both cards.
		const s2 = await ingestRecords(
			[
				rec({
					id: "krea2:argv-injection",
					type: "gotcha",
					title: "Reject leading-dash argv (krea2)",
					tags: ["path-safety", "argv-injection"],
					detail: "krea2 path validation bypass",
				}),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:krea2" },
		);
		expect(s2.created).toBe(1);

		const kreaCard = readFileSync(join(vault, FOLDER, "krea2-argv-injection.md"), "utf8");
		expect(kreaCard).toContain("[[flux2-argv-injection]]");

		// Re-ingest flux2 card so ITS links now include krea2 (bidirectional edge).
		await ingestRecords(
			[
				rec({
					id: "flux2:argv-injection",
					type: "gotcha",
					title: "Reject leading-dash argv (flux2)",
					tags: ["path-safety", "argv-injection"],
					detail: "flux2 path validation bypass",
				}),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:flux2" },
		);
		const fluxCard = readFileSync(join(vault, FOLDER, "flux2-argv-injection.md"), "utf8");
		expect(fluxCard).toContain("[[krea2-argv-injection]]");
	});

	test("dry_run reports but writes nothing", async () => {
		const s = await ingestRecords(
			[rec({ id: "dry:1", title: "Dry" })],
			{
				vaultPath: vault,
				source: "workflow-jsonl",
				sourceLabel: "dry",
				dryRun: true,
			},
		);
		expect(s.created).toBe(1);
		expect(existsSync(join(vault, FOLDER, "dry-1.md"))).toBe(false);
	});
});

describe("formatSummary", () => {
	test("renders a non-empty human-readable block", async () => {
		const s = await ingestRecords(
			[rec({ id: "fmt:1", title: "Fmt" })],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "fmt" },
		);
		const txt = formatSummary(s);
		expect(txt).toContain("vault:");
		expect(txt).toContain("1 created");
	});
});
