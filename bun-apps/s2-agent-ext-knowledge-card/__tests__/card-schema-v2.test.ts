/**
 * Schema v2 (context-lifecycle D4 / ticket 05) contract tests:
 *
 *  - the merge-op table (MERGE_OPS / mergeField) semantics
 *  - the `summary` L0 frontmatter (render + ingest budget gate + idempotency)
 *  - the `experience` card kind (SAR body template)
 *  - wiki-merge consumption of the merge-op table
 *  - the backfill script (stamp + idempotent second run) via Bun.spawn
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	clampSummary,
	mergeField,
	SUMMARY_MAX_CHARS,
} from "../src/card-format.ts";
import { renderCard } from "../src/card-render.ts";
import { firstSentenceSummary, SUMMARY_BODY_BUDGET } from "../src/extractor.ts";
import { ingestRecords } from "../src/ingest.ts";
import { wikiMergeIntoCard } from "../src/wiki-match.ts";
import type { KnowledgeRecord } from "../src/types.ts";

let vault: string;

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

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-v2-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// merge-op table
// ---------------------------------------------------------------------------

describe("merge-op table (D4)", () => {
	test("immutable fields keep the canonical value", () => {
		expect(mergeField("id", "card:a", "card:b")).toBe("card:a");
		expect(mergeField("created", "2026-01-01", "2026-09-09")).toBe("2026-01-01");
	});

	test("summary replaces only with a non-empty incoming value", () => {
		expect(mergeField("summary", "old", "new")).toBe("new");
		expect(mergeField("summary", "old", "  ")).toBe("old");
		expect(mergeField("summary", "old", 42)).toBe("old");
	});

	test("counter-like fields sum; mismatch keeps canonical", () => {
		expect(mergeField("open_task_count", 3, 2)).toBe(5);
		expect(mergeField("embed_count", 1, 0)).toBe(1);
		expect(mergeField("open_task_count", 3, "x")).toBe(3);
	});

	test("union dedups and preserves canonical order", () => {
		expect(mergeField("sources", ["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
		expect(mergeField("tags", ["zettel"], ["zettel", "gotcha"])).toEqual(["zettel", "gotcha"]);
		expect(mergeField("entities", ["tool:x"], "nope")).toEqual(["tool:x"]);
	});

	test("unlisted fields fall through to first-wins", () => {
		expect(mergeField("title", "canonical", "incoming")).toBe("canonical");
	});
});

// ---------------------------------------------------------------------------
// summary L0
// ---------------------------------------------------------------------------

describe("summary L0", () => {
	test("clampSummary bounds to the budget without mid-word cuts", () => {
		const long = "a".repeat(600);
		const clamped = clampSummary(long);
		expect(clamped.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
		expect(clamped.endsWith("…")).toBe(true);
		expect(clampSummary("short one")).toBe("short one");
	});

	test("firstSentenceSummary strips markdown and stops at the boundary", () => {
		expect(firstSentenceSummary("First sentence. Second sentence.")).toBe("First sentence.");
		expect(firstSentenceSummary("## Heading\n- item\n> [!warning] box\nBody text here.")).toBe("Heading item box Body text here.");
		expect(firstSentenceSummary("```js\ncode()\n```\nProse only.")).toBe("Prose only.");
		expect(firstSentenceSummary("")).toBe("");
	});

	test("renderCard emits summary frontmatter only when present", () => {
		const withS = renderCard(rec({ summary: "Abstract." }), "2026-01-01", ["zettel", "gotcha"], [], "test", 1000);
		expect(withS).toContain("summary: Abstract.");
		const without = renderCard(rec(), "2026-01-01", ["zettel", "gotcha"], [], "test", 1000);
		expect(without).not.toContain("summary:");
	});

	test("ingest stamps deterministic summary; LLM fires ONLY over budget + opted in (counter)", async () => {
		let llmCalls = 0;
		const fetchImpl: typeof fetch = (async () => {
			llmCalls++;
			return new Response(JSON.stringify({
				choices: [{ message: { content: '{"summary":"LLM 摘要一句話。"}' } }],
			}), { status: 200 });
		}) as unknown as typeof fetch;

		const longDetail = `${"long ".repeat(300)}Final tail sentence.`;
		expect(longDetail.length).toBeGreaterThan(SUMMARY_BODY_BUDGET);

		// Default (no summaryLlm): deterministic clamp, ZERO LLM calls even over
		// budget — the package tier rule.
		const gated = await ingestRecords(
			[rec({ id: "test:gated", title: "Gated", detail: longDetail })],
			{ vaultPath: vault, source: "generic" as const, sourceLabel: "test", _summaryFetch: fetchImpl },
		);
		expect(gated.created).toBe(1);
		expect(llmCalls).toBe(0);
		const gatedCard = readFileSync(join(vault, "Zettelkasten/knowledge-graph/test-gated.md"), "utf8");
		expect(gatedCard).toMatch(/^summary: .{1,256}$/m);

		// Opted in: short body still deterministic, over-budget body → LLM once.
		const short = await ingestRecords(
			[rec({ id: "test:short", detail: "Short body with one clear sentence. More." })],
			{ vaultPath: vault, source: "generic" as const, sourceLabel: "test", summaryLlm: true, _summaryFetch: fetchImpl },
		);
		expect(llmCalls).toBe(0);
		expect(short.created).toBe(1);
		const shortCard = readFileSync(join(vault, "Zettelkasten/knowledge-graph/test-short.md"), "utf8");
		expect(shortCard).toContain("summary: Short body with one clear sentence.");

		const long = await ingestRecords(
			[rec({ id: "test:long", title: "Long", detail: longDetail })],
			{ vaultPath: vault, source: "generic" as const, sourceLabel: "test", summaryLlm: true, _summaryFetch: fetchImpl },
		);
		expect(llmCalls).toBe(1);
		expect(long.created).toBe(1);
		const longCard = readFileSync(join(vault, "Zettelkasten/knowledge-graph/test-long.md"), "utf8");
		expect(longCard).toContain("summary: LLM 摘要一句話。");
	});

	test("LLM failure falls back to the clamped deterministic sentence (never blocks ingest)", async () => {
		const fetchImpl: typeof fetch = (async () =>
			new Response("nope", { status: 500 })) as unknown as typeof fetch;
		const longDetail = `${"word ".repeat(400)}tail.`;
		const r = await ingestRecords(
			[rec({ id: "test:fail", title: "Fail", detail: longDetail })],
			{ vaultPath: vault, source: "generic" as const, sourceLabel: "test", summaryLlm: true, _summaryFetch: fetchImpl },
		);
		expect(r.created).toBe(1);
		const card = readFileSync(join(vault, "Zettelkasten/knowledge-graph/test-fail.md"), "utf8");
		expect(card).toMatch(/^summary: .{1,256}$/m);
	});

	test("re-ingest is byte-stable (on-disk summary reused, no LLM churn)", async () => {
		let llmCalls = 0;
		const fetchImpl: typeof fetch = (async () => {
			llmCalls++;
			return new Response(JSON.stringify({
				choices: [{ message: { content: '{"summary":"Once only."}' } }],
			}), { status: 200 });
		}) as unknown as typeof fetch;
		const longDetail = `${"body ".repeat(400)}tail.`;
		const opts = {
			vaultPath: vault,
			source: "generic" as const,
			sourceLabel: "test",
			summaryLlm: true,
			_summaryFetch: fetchImpl,
		};
		await ingestRecords([rec({ id: "test:stable", title: "Stable", detail: longDetail })], opts);
		const first = readFileSync(join(vault, "Zettelkasten/knowledge-graph/test-stable.md"), "utf8");
		const second = await ingestRecords([rec({ id: "test:stable", title: "Stable", detail: longDetail })], opts);
		expect(second.unchanged).toBe(1);
		expect(readFileSync(join(vault, "Zettelkasten/knowledge-graph/test-stable.md"), "utf8")).toBe(first);
		expect(llmCalls).toBe(1); // second pass reused the on-disk summary
	});
});

// ---------------------------------------------------------------------------
// experience kind (SAR)
// ---------------------------------------------------------------------------

describe("experience kind (SAR template)", () => {
	test("renders 情境 / 做法 / 反思 sections from the structured payload", () => {
		const out = renderCard(
			rec({
				type: "experience",
				experience: { situation: "LTX 影片輸出雜音。", approach: "改用 purify 二段式。", reflection: "seed 決定一切。" },
			}),
			"2026-01-01", ["zettel", "experience"], [], "test", 1000,
		);
		expect(out).toContain("## 情境 / 做法 / 反思");
		expect(out).toContain("### 情境\nLTX 影片輸出雜音。");
		expect(out).toContain("### 做法\n改用 purify 二段式。");
		expect(out).toContain("### 反思\nseed 決定一切。");
		expect(out).toContain("## 核心想法"); // anatomy anchor preserved for retrieval
	});

	test("missing SAR parts render as —; detail still lands in 核心想法", () => {
		const out = renderCard(rec({ type: "experience" }), "2026-01-01", ["zettel", "experience"], [], "test", 1000);
		expect(out).toContain("### 情境\n—");
		expect(out).toContain("Some detail about the gotcha.");
	});

	test("non-experience cards grow no SAR section", () => {
		const out = renderCard(rec(), "2026-01-01", ["zettel", "gotcha"], [], "test", 1000);
		expect(out).not.toContain("情境 / 做法 / 反思");
	});
});

// ---------------------------------------------------------------------------
// wiki-merge consumption of the merge-op table
// ---------------------------------------------------------------------------

describe("wiki-merge merge-op consumption", () => {
	function seedCard(abs: string) {
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, [
			"---",
			"id: test:card",
			"created: 2026-01-01",
			"tags: [zettel, gotcha, path-safety]",
			"sources: [src-one]",
			"record_type: gotcha",
			"status: active",
			"---",
			"",
			"# Card",
			"",
			"## 核心想法",
			"Body.",
			"",
			"## 證據 / 脈絡",
			"- type: gotcha",
			"- last_seen: 2026-01-01",
			"",
			"## 連結",
			"- (no shared-tag neighbours yet)",
			"",
		].join("\n"));
	}

	test("sources union + summary replace + tags union via the table", () => {
		const abs = join(vault, "card.md");
		seedCard(abs);
		const outcome = wikiMergeIntoCard(
			abs,
			rec({ id: "other:ns", summary: "Fresh abstract.", tags: ["argv"] }),
			"src-two",
			0.9,
			"2026-08-22",
			false,
		);
		expect(outcome).toBe("updated");
		const out = readFileSync(abs, "utf8");
		expect(out).toContain("sources: [src-one, src-two]");
		expect(out).toContain("summary: Fresh abstract.");
		expect(out).toMatch(/tags: \[zettel, gotcha, path-safety, (argv, )?correctness/);
		expect(out).toContain("- wiki-merged: src-two");
		expect(out).toContain("- last_seen: 2026-08-22");
	});

	test("empty incoming summary leaves the card's summary alone (replace op guard)", () => {
		const abs = join(vault, "card.md");
		seedCard(abs);
		// Pre-stamp a summary so we can observe it surviving.
		let raw = readFileSync(abs, "utf8");
		raw = raw.replace("record_type: gotcha", "record_type: gotcha\nsummary: Canonical abstract.");
		writeFileSync(abs, raw);
		wikiMergeIntoCard(abs, rec({ id: "other:ns" }), "src-two", 0.9, "2026-08-22", false);
		expect(readFileSync(abs, "utf8")).toContain("summary: Canonical abstract.");
	});

	test("idempotent: second identical merge is unchanged", () => {
		const abs = join(vault, "card.md");
		seedCard(abs);
		const incoming = rec({ id: "other:ns", summary: "Fresh abstract.", tags: ["argv"] });
		wikiMergeIntoCard(abs, incoming, "src-two", 0.9, "2026-08-22", false);
		expect(
			wikiMergeIntoCard(abs, incoming, "src-two", 0.9, "2026-08-22", false),
		).toBe("unchanged");
	});
});

// ---------------------------------------------------------------------------
// backfill script (spawned, real temp vault)
// ---------------------------------------------------------------------------

describe("backfill-summaries.mjs", () => {
	test("stamps active cards, skips superseded, second run is a no-op", () => {
		const folder = join(vault, "Zettelkasten/knowledge-graph");
		mkdirSync(folder, { recursive: true });
		const card = (id: string, status: string) => [
			"---",
			`id: ${id}`,
			"created: 2026-01-01",
			"tags: [zettel, gotcha]",
			"record_type: gotcha",
			`status: ${status}`,
			"---",
			"",
			"# Card",
			"",
			"## 核心想法",
			`${id} first sentence here. Second sentence.`,
			"",
			"## 證據 / 脈絡",
			"- type: gotcha",
			"",
		].join("\n");
		writeFileSync(join(folder, "a.md"), card("test:a", "active"));
		writeFileSync(join(folder, "b.md"), card("test:b", "superseded"));
		writeFileSync(join(folder, "c.md"), card("test:c", "active"));
		// Legacy human-authored note: English `## Core Idea` header, no
		// record_type — the anchor-less insertion + whole-body fallback path.
		writeFileSync(join(folder, "legacy.md"), [
			"---",
			"id: 202506151508",
			"created: 2025-06-15",
			"tags: [zettel, debugging]",
			"status: active",
			"---",
			"",
			"# Legacy note",
			"",
			"## Core Idea",
			"Legacy prose first sentence here. Second.",
			"",
		].join("\n"));

		// P2-guarded spawn: process.execPath (the running bun binary), never a
		// bare host-binary name (test-portability-audit --strict).
		const run = (args: string[]) => spawnSync(
			process.execPath, ["scripts/backfill-summaries.mjs", "--vault", vault, ...args],
			{ cwd: join(import.meta.dir, ".."), encoding: "utf8" },
		);
		const first = run([]);
		expect(first.status).toBe(0);
		const receipt1 = JSON.parse(first.stdout);
		expect(receipt1.active).toBe(3);
		expect(receipt1.stamped).toBe(3);
		expect(receipt1.reEmbedBurst).toBe(3);

		const a = readFileSync(join(folder, "a.md"), "utf8");
		expect(a).toContain('summary: "test:a first sentence here."'); // colon → yamlScalar quotes
		const b = readFileSync(join(folder, "b.md"), "utf8");
		expect(b).not.toContain("summary:");
		const legacy = readFileSync(join(folder, "legacy.md"), "utf8");
		expect(legacy).toContain("summary: Legacy prose first sentence here.");
		expect(legacy.indexOf("summary:")).toBeLessThan(legacy.indexOf("---", 4)); // inside the fence

		const second = run([]);
		const receipt2 = JSON.parse(second.stdout);
		expect(receipt2.stamped).toBe(0);
		expect(receipt2.alreadySummarized).toBe(3);
		expect(receipt2.reEmbedBurst).toBe(0);
	}, 60_000);
});
