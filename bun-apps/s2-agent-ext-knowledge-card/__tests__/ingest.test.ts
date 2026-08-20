/**
 * Contract tests for the deterministic knowledge-graph ingest primitive.
 *
 * These exercise the library end-to-end against a real temp vault (no mocks):
 * parse → ingest → validate cards → dedup → cross-source link → MOC. The
 * graph-density claim (the whole point of convergence) is asserted by feeding
 * records from TWO different sources with overlapping tags and checking the
 * edges actually form across the source boundary.
 */
import { test, expect, describe, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ingestRecords,
	formatSummary,
	readCardMeta,
} from "../src/ingest.ts";
import {
	parseKnowledgeJsonl,
	adaptAutoMemoryMarkdown,
	adaptHermesMarkdown,
	stripWikiLinkBrackets,
	collectInputFiles,
	extractDate,
} from "../src/adapters.ts";
import { slugify } from "../src/card-format.ts";
import { extractFeatures } from "../src/card-render.ts";
import type { KnowledgeRecord } from "../src/types.ts";
import { validateZettelNote } from "@repo/s2-agent-ext-obsidian";
import { LlmRelationExtractor, type Extractor } from "../src/extractor.ts";
import { retrieveRecords } from "../src/retrieve.ts";

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

	test("harvests body #hashtags as cross-link tags", () => {
		const md = [
			"---",
			"name: ltx-cfg-lever",
			'description: "LTX cfg lever"',
			"metadata:",
			"  type: feedback",
			"---",
			"",
			"Set cfg=7 for LTX. Related #ltx #video-gen.",
			"URL https://x.com/#anchor should NOT be harvested.",
		].join("\n");
		const rec = adaptAutoMemoryMarkdown(md);
		expect(rec!.tags).toContain("ltx");
		expect(rec!.tags).toContain("video-gen");
		expect(rec!.tags.some((t) => t.includes("anchor"))).toBe(false); // url fragment excluded
	});

	test("does not treat a markdown heading as a hashtag", () => {
		const md = [
			"---",
			"name: x",
			'description: "desc"',
			"metadata:",
			"  type: reference",
			"---",
			"",
			"# A heading",
			"## Subheading",
		].join("\n");
		const rec = adaptAutoMemoryMarkdown(md);
		// `# A heading` — space after #, no tag harvested; only auto-memory + reference.
		expect(rec!.tags).toEqual(["auto-memory", "reference"]);
	});

	test("strips [[wiki-link]] brackets from the detail body (keeps prose, no dead links)", () => {
		const md = [
			"---",
			"name: x",
			'description: "desc"',
			"metadata:",
			"  type: reference",
			"---",
			"",
			"See [[sibling-topic]] and [[other-topic|the alias]] and [[anchor-host#section]].",
		].join("\n");
		const rec = adaptAutoMemoryMarkdown(md);
		expect(rec!.detail).not.toContain("[[");
		expect(rec!.detail).not.toContain("]]");
		expect(rec!.detail).toContain("sibling-topic"); // bare text preserved
		expect(rec!.detail).toContain("the alias"); // alias form → alias text
		expect(rec!.detail).toContain("anchor-host"); // #anchor form → target text
		// The sibling slugs are still harvested as cross-link TAGS (graph edges
		// live in `## 連結`, not in body prose).
		expect(rec!.tags).toContain("sibling-topic");
		expect(rec!.tags).toContain("other-topic");
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

describe("adaptHermesMarkdown", () => {
	test("parses a [failure] entry into a record (type=avoid, id namespaced)", () => {
		const md = [
			"[failure] ARG-PARSE LOOP MUST ADVANCE INDEX (args.ts): a missed i++ spins forever.",
			"FIX: advance the cursor on every branch. <!-- created=2026-06-28, last=2026-06-29 -->",
			"§",
		].join("\n");
		const recs = adaptHermesMarkdown(md);
		expect(recs.length).toBe(1);
		const r = recs[0]!;
		expect(r.id).toMatch(/^hermes:/);
		expect(r.id).toContain("arg-parse"); // slug from title
		expect(r.type).toBe("avoid"); // failure → avoid
		expect(r.dimension).toBe("failure"); // literal category preserved
		expect(r.tags).toContain("hermes");
		expect(r.tags).toContain("failure");
		expect(r.confidence).toBe(0.9);
		expect(r.evidence?.first_seen).toBe("2026-06-28");
		expect(r.evidence?.last_seen).toBe("2026-06-29");
	});

	test("maps each [category] prefix to the right record type", () => {
		const mk = (prefix: string) =>
			`${prefix} Some title here. Body text. <!-- created=2026-07-01, last=2026-07-01 -->`;
		expect(adaptHermesMarkdown(mk("[tool-quirk]"))[0]!.type).toBe("gotcha");
		expect(adaptHermesMarkdown(mk("[insight]"))[0]!.type).toBe("pattern");
		expect(adaptHermesMarkdown(mk("[correction]"))[0]!.type).toBe("false_positive");
		expect(adaptHermesMarkdown(mk("[convention]"))[0]!.type).toBe("pattern");
		expect(adaptHermesMarkdown(mk("[preference]"))[0]!.type).toBe("pattern");
	});

	test("a prefix-less entry infers its category from content", () => {
		const md =
			"**Tool quirks** (verified 2026-06-29):\n• Some bullet fact. <!-- created=2026-06-29, last=2026-06-29 -->\n§\n";
		const recs = adaptHermesMarkdown(md);
		expect(recs.length).toBe(1);
		// No `[category]` prefix, but content matches the tool-quirk signal
		// ("quirks") → inferred category tool-quirk → type gotcha, dimension tool-quirk
		// (previously defaulted to type=pattern / dimension=general).
		expect(recs[0]!.type).toBe("gotcha");
		expect(recs[0]!.dimension).toBe("tool-quirk");
		expect(recs[0]!.title).toBe("Tool quirks"); // ** stripped, trailing (date): stripped
	});

	test("returns one record per § entry in a multi-entry file", () => {
		const md = [
			"[failure] First entry. Body one. <!-- created=2026-06-28, last=2026-06-28 -->",
			"§",
			"[tool-quirk] Second entry. Body two. <!-- created=2026-06-29, last=2026-06-29 -->",
			"§",
			"[insight] Third entry. Body three. <!-- created=2026-06-30, last=2026-06-30 -->",
		].join("\n");
		const recs = adaptHermesMarkdown(md);
		expect(recs.length).toBe(3);
		expect(recs[0]!.type).toBe("avoid");
		expect(recs[1]!.type).toBe("gotcha");
		expect(recs[2]!.type).toBe("pattern");
		expect(recs.map((r) => r.id)).toEqual([...new Set(recs.map((r) => r.id))]); // unique ids
	});

	test("detail carries the full body (minus prefix + timestamp); brackets stripped", () => {
		const md =
			"[insight] Porting rule. See [[vae-decode-range]] for the dark-half bug. <!-- created=2026-07-01, last=2026-07-02 -->";
		const r = adaptHermesMarkdown(md)[0]!;
		expect(r.detail).toContain("Porting rule");
		expect(r.detail).not.toContain("<!--"); // timestamp stripped from detail
		expect(r.detail).not.toContain("[["); // wiki brackets stripped
		expect(r.detail).toContain("vae-decode-range"); // link text preserved as prose
		expect(r.tags).toContain("vae-decode-range"); // [[link]] also harvested as tag
	});

	test("handles duplicated timestamp comments (takes first created, last last)", () => {
		const md =
			"[failure] X. Body. <!-- created=2026-06-28, last=2026-06-29 --> <!-- created=2026-06-28, last=2026-06-29 -->";
		const r = adaptHermesMarkdown(md)[0]!;
		expect(r.evidence?.first_seen).toBe("2026-06-28");
		expect(r.evidence?.last_seen).toBe("2026-06-29");
		expect(r.detail).not.toContain("<!--");
	});

	test("defensive: empty / no-timestamp / malformed entries are skipped, never throw", () => {
		expect(adaptHermesMarkdown("")).toEqual([]);
		expect(adaptHermesMarkdown("   \n\n  ")).toEqual([]);
		// entry with ONLY a timestamp comment (no body after strip) → skipped
		expect(adaptHermesMarkdown("<!-- created=2026-07-01, last=2026-07-01 -->\n§\n")).toEqual([]);
		// an entry with no timestamp still parses (evidence undefined)
		const r = adaptHermesMarkdown("[insight] A timestamp-less note.\n§\n")[0]!;
		expect(r.evidence).toBeUndefined();
		expect(r.type).toBe("pattern");
	});

	test("title is cut at the first clause boundary, not mid-word", () => {
		const md =
			"[tool-quirk] Always use Bun — never node/npm/yarn. `bun test` runs files fine. <!-- created=2026-07-07, last=2026-07-11 -->";
		const r = adaptHermesMarkdown(md)[0]!;
		expect(r.title).toBe("Always use Bun"); // cut at ` — `, not truncated mid-word
		expect(r.title.length).toBeLessThanOrEqual(80);
		expect(r.id).toContain("always-use-bun");
	});

	test("created-only timestamp (no last=) is recovered instead of 1970", () => {
		const md = "[preference] After PR squash-merge delete both branches. <!-- created=2026-07-06 -->";
		const r = adaptHermesMarkdown(md)[0]!;
		expect(r.evidence?.first_seen).toBe("2026-07-06");
		expect(r.evidence?.last_seen).toBe("2026-07-06"); // last defaults to created
	});

	test("tags filter stopwords but keep semantic short tokens (bun/vae)", () => {
		const md =
			"[preference] Always use Bun for sqlite. The vae decode needs *0.5+0.5. <!-- created=2026-07-07, last=2026-07-11 -->";
		const r = adaptHermesMarkdown(md)[0]!;
		expect(r.tags).toContain("bun"); // 3-char semantic token survives (old ≥4 gate dropped it)
		expect(r.tags).toContain("vae");
		expect(r.tags).toContain("sqlite");
		expect(r.tags).not.toContain("always"); // modal filler now filtered
		expect(r.tags).not.toContain("never");
	});

	test("hermes records converge + cross-link a workflow card via shared tags", async () => {
		// Seed a workflow gotcha card sharing the `argparse` concept tag.
		await ingestRecords(
			[
				rec({
					id: "cli:argparse-i-advance",
					type: "gotcha",
					title: "Argv loop must advance i",
					tags: ["argparse", "argv"],
					detail: "Every branch must i++.",
				}),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "workflow-jsonl:cli" },
		);
		// A hermes failure entry whose title yields the `argparse` keyword tag.
		const hRecs = adaptHermesMarkdown(
			"[failure] ARGPARSE loop must advance index. Missed i++ hangs. <!-- created=2026-06-28, last=2026-06-29 -->",
		);
		expect(hRecs[0]!.tags).toContain("argparse");
		const s = await ingestRecords(hRecs, {
			vaultPath: vault,
			source: "hermes",
			sourceLabel: "hermes:failures",
		});
		expect(s.created).toBe(1);
		// Shared `argparse` tag → a cross-source edge in the hermes card.
		const names = readdirSync(join(vault, FOLDER));
		const hermesCard = names.find((n) => n.startsWith("hermes-"))!;
		const body = readFileSync(join(vault, FOLDER, hermesCard), "utf8");
		expect(body).toContain("[[cli-argparse-i-advance]]");
	});
});

describe("collectInputFiles", () => {
	const memMd = (name: string) =>
		[
			"---",
			`name: ${name}`,
			'description: "d"',
			"metadata:",
			"  type: reference",
			"---",
			"",
			"body",
		].join("\n");

	test("expands a directory recursively for auto-memory (.md), skipping index files", () => {
		const root = mkdtempSync(join(tmpdir(), "kcard-collect-"));
		try {
			writeFileSync(join(root, "a.md"), memMd("a"));
			writeFileSync(join(root, "MEMORY.md"), "# index rollup, must be skipped");
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "sub", "b.md"), memMd("b"));
			writeFileSync(join(root, "notes.txt"), "not markdown");
			const { files, skipped } = collectInputFiles([root], { source: "auto-memory", cwd: root });
			const bases = files.map((f) => f.split("/").pop());
			expect(bases).toContain("a.md");
			expect(bases).toContain("b.md");
			expect(bases).not.toContain("MEMORY.md"); // index rollup excluded
			expect(bases).not.toContain("notes.txt");
			expect(skipped).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports missing paths in skipped, never throws", () => {
		const { files, skipped } = collectInputFiles(["/no/such/path/xyz"], {
			source: "auto-memory",
			cwd: "/",
		});
		expect(files).toEqual([]);
		expect(skipped.length).toBe(1);
		expect(skipped[0]!.reason).toMatch(/not found/);
	});

	test("explicit files pass through unchanged (no dir expansion)", () => {
		const root = mkdtempSync(join(tmpdir(), "kcard-collect-"));
		try {
			const fAbs = join(root, "x.md");
			writeFileSync(fAbs, memMd("x"));
			const { files } = collectInputFiles([fAbs], { source: "auto-memory", cwd: "/" });
			expect(files).toEqual([fAbs]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("workflow-jsonl source globs .knowledge.jsonl, not .md", () => {
		const root = mkdtempSync(join(tmpdir(), "kcard-collect-"));
		try {
			writeFileSync(join(root, "a.knowledge.jsonl"), '{"id":"a:1"}');
			writeFileSync(join(root, "b.md"), memMd("b"));
			const { files } = collectInputFiles([root], { source: "workflow-jsonl", cwd: root });
			const bases = files.map((f) => f.split("/").pop());
			expect(bases).toEqual(["a.knowledge.jsonl"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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

	test("dry-run is a true idempotency probe: unchanged existing cards report unchanged (not updated)", async () => {
		const opts = {
			vaultPath: vault,
			source: "workflow-jsonl" as const,
			sourceLabel: "s",
		};
		const r = rec({ id: "x:dryidem", title: "Stable" });
		await ingestRecords([r], opts); // create
		// dry-run re-ingest of the SAME record → unchanged (content matches), 0 updated.
		const sDry = await ingestRecords([r], { ...opts, dryRun: true });
		expect(sDry.unchanged).toBe(1);
		expect(sDry.updated).toBe(0);
		expect(sDry.created).toBe(0);
		// a CHANGED record in dry-run → updated (content differs), file NOT written.
		const sDryUpd = await ingestRecords(
			[rec({ id: "x:dryidem", title: "Changed" })],
			{ ...opts, dryRun: true },
		);
		expect(sDryUpd.updated).toBe(1);
		expect(existsSync(join(vault, FOLDER, "x-dryidem.md"))).toBe(true); // created earlier
		const body = readFileSync(join(vault, FOLDER, "x-dryidem.md"), "utf8");
		expect(body).toContain("Stable"); // dry-run wrote nothing → still the old title
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

	test("re-ingesting a card that has on-disk neighbours emits NO duplicate links", async () => {
		// Regression: the neighbour candidate pool combines on-disk cards
		// (`existing`) with this batch (`planned`). A card present in BOTH — i.e.
		// an upsert / re-ingest of a source whose cards are already on disk —
		// used to be counted twice, producing duplicate `相關：[[...]]` lines.
		const opts = { vaultPath: vault, source: "workflow-jsonl" as const, sourceLabel: "s" };
		const flux = rec({
			id: "flux2:argv-injection",
			type: "gotcha",
			title: "Reject leading-dash argv (flux2)",
			tags: ["path-safety", "argv-injection"],
		});
		const krea = rec({
			id: "krea2:argv-injection",
			type: "gotcha",
			title: "Reject leading-dash argv (krea2)",
			tags: ["path-safety", "argv-injection"],
		});
		await ingestRecords([flux, krea], opts);
		const first = readFileSync(join(vault, FOLDER, "flux2-argv-injection.md"), "utf8");
		// Re-ingest flux2 (already on disk, krea2 is a neighbour) → upsert case.
		const s = await ingestRecords([flux], opts);
		expect(s.unchanged).toBe(1);
		const after = readFileSync(join(vault, FOLDER, "flux2-argv-injection.md"), "utf8");
		const linkLines = after.split("\n").filter((l) => l.startsWith("- 相關："));
		// Every link line must be unique (no duplicates)…
		expect(new Set(linkLines).size).toBe(linkLines.length);
		// …and the card body must be byte-identical to the first write (true
		// idempotency, the duplicate-link bug broke this invariant).
		expect(after).toBe(first);
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

// ---------------------------------------------------------------------------
// Stage 1 (P1) — Obsidian feature metadata extraction → additive frontmatter
// ---------------------------------------------------------------------------

describe("extractFeatures", () => {
	test("detects a callout block + its type + headline text", () => {
		const body = [
			"Intro prose.",
			"> [!warning] Never run X without the guard.",
			"> It will corrupt the index.",
			"More prose.",
		].join("\n");
		const f = extractFeatures(body);
		expect(f.hasCallouts).toBe(true);
		expect(f.calloutTypes).toEqual(["warning"]);
		expect(f.calloutTexts[0]).toContain("[!warning]");
		expect(f.calloutTexts[0]).toContain("Never run X without the guard");
	});

	test("callout headline falls back to first continuation line when title is empty", () => {
		const f = extractFeatures("> [!tip]\n> Use cfg=7 for sharper edges.\n");
		expect(f.calloutTypes).toEqual(["tip"]);
		expect(f.calloutTexts[0]).toContain("Use cfg=7 for sharper edges");
	});

	test("counts open + closed tasks and embeds (not wiki-links)", () => {
		const body = [
			"- [ ] todo one",
			"- [x] done thing",
			"See ![[embedded-note]] and ![[image.png]].",
			"A plain [[wiki-link]] must NOT count as an embed.",
		].join("\n");
		const f = extractFeatures(body);
		expect(f.hasTasks).toBe(true);
		expect(f.openTaskCount).toBe(1);
		expect(f.closedTaskCount).toBe(1);
		expect(f.embedCount).toBe(2);
	});

	test("does not count tasks/embeds inside fenced code blocks", () => {
		const body = [
			"```py",
			"- [ ] this is code, not a task",
			"![[not-an-embed]]",
			"```",
			"- [ ] real task",
		].join("\n");
		const f = extractFeatures(body);
		expect(f.openTaskCount).toBe(1);
		expect(f.embedCount).toBe(0);
		expect(f.codeBlockCount).toBe(1);
		expect(f.codeBlockLines).toBeGreaterThanOrEqual(2);
	});

	test("returns an empty result for feature-less prose", () => {
		const f = extractFeatures("Just a plain paragraph about flux2. No features here.");
		expect(f.hasCallouts).toBe(false);
		expect(f.calloutTypes).toEqual([]);
		expect(f.hasTasks).toBe(false);
		expect(f.embedCount).toBe(0);
		expect(f.codeBlockLines).toBe(0);
	});
});

describe("ingestRecords — additive feature frontmatter (P1)", () => {
	test("a callout + task body ingests with has_callouts + callout_types + has_tasks", async () => {
		const detail = [
			"A gotcha about argv injection.",
			"> [!warning] Reject leading-dash argv.",
			"> It bypasses path validation.",
			"- [ ] add a regression test",
		].join("\n");
		await ingestRecords(
			[rec({ id: "feat:callout", title: "Callout card", detail })],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "feat" },
		);
		const card = readFileSync(join(vault, FOLDER, "feat-callout.md"), "utf8");
		expect(validateZettelNote(card).ok).toBe(true);
		expect(card).toContain("has_callouts: true");
		expect(card).toContain("callout_types: [warning]");
		expect(card).toContain("has_tasks: true");
		expect(card).toContain("open_task_count: 1");
		// readCardMeta surfaces the flag for feature-aware retrieval.
		const meta = readCardMeta(join(vault, FOLDER, "feat-callout.md"))!;
		expect(meta.hasCallouts).toBe(true);
		expect(meta.calloutTypes).toEqual(["warning"]);
	});

	test("a feature-less record gains NO feature keys (byte-identical, backward-compat)", async () => {
		await ingestRecords(
			[rec({ id: "feat:plain", title: "Plain card", detail: "Just prose, no callouts or tasks." })],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "feat" },
		);
		const card = readFileSync(join(vault, FOLDER, "feat-plain.md"), "utf8");
		expect(card).not.toContain("has_callouts");
		expect(card).not.toContain("callout_types");
		expect(card).not.toContain("has_tasks");
		expect(card).not.toContain("embed_count");
		expect(validateZettelNote(card).ok).toBe(true);
		const meta = readCardMeta(join(vault, FOLDER, "feat-plain.md"))!;
		expect(meta.hasCallouts).toBe(false);
		expect(meta.calloutTypes).toEqual([]);
	});

	test("multiple callout types are all captured in order", async () => {
		const detail = [
			"> [!warning] careful here",
			"> [!tip] or do this instead",
		].join("\n");
		await ingestRecords(
			[rec({ id: "feat:multi", title: "Multi", detail })],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "feat" },
		);
		const card = readFileSync(join(vault, FOLDER, "feat-multi.md"), "utf8");
		expect(card).toContain("callout_types: [warning, tip]");
	});
});

describe("in-batch canonical-id dedup", () => {
	test("two records with the same id in one fresh batch upsert onto one card (no -2 duplicate)", async () => {
		// Without in-batch dedup, the slug-collision loop only consults DISK via
		// readCardMeta. The second same-id record finds no on-disk card yet (both
		// are in the same fresh batch) → disambiguates to `<slug>-2`, emitting TWO
		// cards with the same source_id — violating "dedup by canonical record id".
		const opts = { vaultPath: vault, source: "workflow-jsonl" as const, sourceLabel: "t" };
		await ingestRecords(
			[
				rec({ id: "test:dup", title: "First occurrence", detail: "first body content" }),
				rec({ id: "test:dup", title: "Second occurrence", detail: "second body content" }),
			],
			opts,
		);
		const dir = join(vault, FOLDER);
		const slugFiles = readdirSync(dir).filter((f) => /^test-dup(-\d+)?\.md$/.test(f));
		expect(slugFiles).toEqual(["test-dup.md"]); // exactly one card for the canonical id
		expect(existsSync(join(dir, "test-dup-2.md"))).toBe(false);
		// last record wins (upsert-in-place semantics, matching on-disk re-ingest)
		const body = readFileSync(join(dir, "test-dup.md"), "utf8");
		expect(body).toContain("second body content");
	});
});

describe("ingestRecords — LLM relations write path (Phase-2 T3)", () => {
	/** Canned chat-completions payload: typed entities + two relations. The
	 *  LlmRelationExtractor is injected via IngestOptions._extractor with a
	 *  canned _fetchImpl (deterministic, no live LM Studio). */
	const LLM_PAYLOAD = JSON.stringify({
		entities: [
			{ type: "tool", name: "run.py" },
			{ type: "model", name: "Z-Image" },
			{ type: "config", name: "--cfg-scale" },
		],
		relations: [
			{ s: "run.py", rel: "uses", o: "Z-Image" },
			{ s: "run.py", rel: "configures", o: "--cfg-scale" },
		],
	});

	function chatContent(content: string): Response {
		return new Response(
			JSON.stringify({ choices: [{ message: { content } }] }),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}
	function cannedFetch(content: string): typeof fetch {
		return (async () => chatContent(content)) as unknown as typeof fetch;
	}

	const llmExtractor = () => new LlmRelationExtractor({ _fetchImpl: cannedFetch(LLM_PAYLOAD) });

	/** The EXACT block the zk emitter must write — hardcoded as the shared
	 *  cross-package artifact (the same string lives in hermes's
	 *  knowledge-serializer.test.ts, so a drift on either reader/emitter side
	 *  breaks one of the two suites). */
	const EXPECTED_RELATIONS_BLOCK = [
		"relations:",
		"  - s: run.py",
		"    rel: uses",
		"    o: Z-Image",
		"  - s: run.py",
		"    rel: configures",
		"    o: --cfg-scale",
	].join("\n");

	const EXPECTED_TRIPLES = [
		{ s: "run.py", rel: "uses", o: "Z-Image" },
		{ s: "run.py", rel: "configures", o: "--cfg-scale" },
	];

	test("kgLlm ON + idf: relations block written, entities present, round-trips via retrieveRecords", async () => {
		await ingestRecords(
			[rec({
				id: "llm:rel",
				title: "LLM rel card",
				detail: "run.py generates images with Z-Image at --cfg-scale 3.5.",
			})],
			{
				vaultPath: vault,
				source: "workflow-jsonl",
				sourceLabel: "llm",
				linkWeighting: "idf",
				kgLlm: true,
				_extractor: llmExtractor(),
			},
		);
		const card = readFileSync(join(vault, FOLDER, "llm-rel.md"), "utf8");
		// the exact nested block (both readers' contract)
		expect(card).toContain(EXPECTED_RELATIONS_BLOCK);
		// still a valid zettel
		expect(validateZettelNote(card).ok).toBe(true);
		// dictionary-entity frontmatter flow intact under idf (LLM entities used)
		expect(card).toMatch(/^entities: \[/m);
		// round-trip: retrieveRecords' parseRelationsBlock recovers the triples
		const rr = await retrieveRecords({
				vaultPath: vault,
				tags: ["path-safety"],
				maxDetailChars: 500,
				topK: 10,
			});
		const hit = rr.cards.find((c) => c.id === "llm:rel");
		expect(hit?.relations).toEqual(EXPECTED_TRIPLES);
	});

	test("kgLlm ON + non-idf (count): relations block present, NO entity frontmatter", async () => {
		await ingestRecords(
			[rec({
				id: "llm:count",
				title: "Count-mode LLM card",
				detail: "run.py generates images with Z-Image at --cfg-scale 3.5.",
			})],
			{
				vaultPath: vault,
				source: "workflow-jsonl",
				sourceLabel: "llm",
				kgLlm: true,
				_extractor: llmExtractor(),
			},
		);
		const card = readFileSync(join(vault, FOLDER, "llm-count.md"), "utf8");
		expect(card).toContain(EXPECTED_RELATIONS_BLOCK);
		// entity frontmatter stays idf-gated even with kgLlm ON
		expect(card).not.toMatch(/^entities:/m);
		expect(validateZettelNote(card).ok).toBe(true);
	});

	test("kgLlm OFF: NO relations block ever (write authority — dictionary path emits entities only)", async () => {
		// idf mode (the widest dictionary surface) still never emits relations
		await ingestRecords(
			[rec({
				id: "dict:rel",
				title: "Dictionary card",
				detail: "run.py generates images with Z-Image at --cfg-scale 3.5.",
			})],
			{
				vaultPath: vault,
				source: "workflow-jsonl",
				sourceLabel: "dict",
				linkWeighting: "idf",
				kgLlm: false,
			},
		);
		const card = readFileSync(join(vault, FOLDER, "dict-rel.md"), "utf8");
		expect(card).not.toContain("relations:");
		// the idf entity flow is unchanged
		expect(card).toMatch(/^entities: \[/m);
		expect(validateZettelNote(card).ok).toBe(true);
	});

	test("kgLlm OFF + LLM degradation (canned 500): extractor falls back to dictionary, no relations block", async () => {
		// never-throws at the ingest boundary: even kgLlm ON with a dead chat
			// endpoint degrades to the dictionary result (entities only)
		const failing = new LlmRelationExtractor({
			_fetchImpl: (async () =>
				new Response("boom", { status: 500 })) as unknown as typeof fetch,
		});
		await ingestRecords(
			[rec({
				id: "llm:dead",
				title: "Dead-endpoint card",
				detail: "run.py generates images with Z-Image at --cfg-scale 3.5.",
			})],
			{
				vaultPath: vault,
				source: "workflow-jsonl",
				sourceLabel: "llm",
				linkWeighting: "idf",
				kgLlm: true,
				_extractor: failing,
			},
		);
		const card = readFileSync(join(vault, FOLDER, "llm-dead.md"), "utf8");
		expect(card).not.toContain("relations:");
		expect(card).toMatch(/^entities: \[/m);
		expect(validateZettelNote(card).ok).toBe(true);
	});

	/** P2 FIX C (card-truncation parity): the kgLlm extract prompt must see
	 *  the SAME capped detail the rendered card writes — a pathological record
	 *  can never ship a multi-MB prompt to the chat endpoint. The injected
	 *  extractor CAPTURES the received text so the exact prompt is asserted. */
	function capturingExtractor(captured: string[]): Extractor {
		return {
			extract: async (text: string) => {
				captured.push(text);
				return { entities: [], relations: [] };
			},
		};
	}

	test("kgLlm ON: extract prompt detail capped at maxDetailChars (card-truncation parity)", async () => {
		const CAP = 64;
		const TRUNC_MARK = "\n\n…(truncated)";
		const title = "Cap probe card "; // includes the join space
		const captured: string[] = [];
		await ingestRecords(
			[rec({ id: "llm:cap", title: "Cap probe card", detail: "x".repeat(100_000) })],
			{
				vaultPath: vault,
				source: "workflow-jsonl",
				sourceLabel: "llm",
				linkWeighting: "idf",
				kgLlm: true,
				maxDetailChars: CAP,
				_extractor: capturingExtractor(captured),
			},
		);
		// the prompt is title + capped detail + truncation marker — NOT 100k chars
		expect(captured.length).toBe(1);
		const prompt = captured[0]!;
		expect(prompt.startsWith(title)).toBe(true);
		expect(prompt.length).toBeLessThanOrEqual(title.length + CAP + TRUNC_MARK.length);
		expect(prompt).toContain("…(truncated)");
		// the card md still applies its own (same-mechanism) truncation
		const card = readFileSync(join(vault, FOLDER, "llm-cap.md"), "utf8");
		expect(card).toContain("…(truncated)");
		expect(card).not.toContain("x".repeat(CAP + 1));
		expect(validateZettelNote(card).ok).toBe(true);
	});

	test("kgLlm ON: maxDetailChars undefined → prompt uses renderCard's 32_000 default", async () => {
		const TRUNC_MARK = "\n\n…(truncated)";
		const title = "Default cap card ";
		const captured: string[] = [];
		await ingestRecords(
			[rec({ id: "llm:dcap", title: "Default cap card", detail: "y".repeat(100_000) })],
			{
				vaultPath: vault,
				source: "workflow-jsonl",
				sourceLabel: "llm",
				kgLlm: true,
				_extractor: capturingExtractor(captured),
			},
		);
		const prompt = captured[0]!;
		expect(prompt.length).toBeLessThanOrEqual(title.length + 32_000 + TRUNC_MARK.length);
		expect(prompt).toContain("…(truncated)");
	});
});

describe("stripWikiLinkBrackets", () => {
	it("unwraps a plain target", () => {
		expect(stripWikiLinkBrackets("[[foo]]")).toBe("foo");
	});
	it("prefers an alias over the target", () => {
		expect(stripWikiLinkBrackets("[[foo|bar]]")).toBe("bar");
	});
	it("strips a heading anchor, keeps the target", () => {
		expect(stripWikiLinkBrackets("[[foo#section]]")).toBe("foo");
	});
	it("alias wins even when an anchor is present", () => {
		expect(stripWikiLinkBrackets("[[foo#section|bar]]")).toBe("bar");
	});
	it("leaves non-wiki-link text untouched", () => {
		expect(stripWikiLinkBrackets("plain text")).toBe("plain text");
	});
	it("handles multiple links in one string", () => {
		expect(stripWikiLinkBrackets("see [[a]] and [[b|bb]]")).toBe("see a and bb");
	});
});
