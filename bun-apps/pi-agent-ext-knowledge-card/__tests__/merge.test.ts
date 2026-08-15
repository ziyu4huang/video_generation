/**
 * Contract tests for deterministic semantic-ish duplicate merge.
 *
 * Exercises merge.ts against a real temp vault (no mocks): ingest two
 * near-identical records → detect the pair at ≥0.9 → merge → the loser is
 * archived + marked superseded, inbound links are rewritten, the canonical
 * card survives. Also asserts the safety gate: two merely-related (low-
 * similarity) cards are NOT merged.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRecords } from "../src/ingest.ts";
import type { KnowledgeRecord } from "../src/types.ts";
import { mergeDuplicates, findDuplicatePairs } from "../src/merge.ts";

let vault: string;
const FOLDER = "Zettelkasten/knowledge-graph";

function rec(over: Partial<KnowledgeRecord>): KnowledgeRecord {
	return {
		type: "gotcha",
		title: "Base",
		detail: "Base detail.",
		tags: ["argv"],
		dimension: "correctness",
		confidence: 0.8,
		status: "active",
		superseded_by: null,
		...over,
	} as KnowledgeRecord;
}

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kcard-merge-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

/** Two cards whose title + core idea are nearly identical (Jaccard ≥ 0.9). */
const DUPE_DETAIL_A =
	"flux2 distilled klein models ignore cfg-scale and stg-scale guidance; classifier-free guidance does not transfer to distilled one-step transformers.";
const DUPE_DETAIL_B =
	"flux2 distilled klein models ignore cfg-scale and stg-scale guidance; classifier-free guidance does not transfer to distilled one-step transformers.";

describe("mergeDuplicates — synthetic duplicate pair", () => {
	test("detects a ≥0.9 near-duplicate pair (dry-run reports, no writes)", async () => {
		await ingestRecords(
			[
				rec({ id: "flux:cfg-distilled-a", title: "CFG guidance ignored on distilled flux2", detail: DUPE_DETAIL_A, confidence: 0.9 }),
				rec({ id: "flux:cfg-distilled-b", title: "CFG guidance ignored on distilled flux2", detail: DUPE_DETAIL_B, confidence: 0.7 }),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "test" },
		);

		const dry = await mergeDuplicates({ vaultPath: vault, threshold: 0.9, dryRun: true });
		expect(dry.pairs.length).toBe(1);
		expect(dry.merged).toBe(0);
		// Dry-run must not move anything to _archive/.
		expect(existsSync(join(vault, FOLDER, "_archive"))).toBe(false);
		// Both cards still active in the flat folder.
		expect(readdirSync(join(vault, FOLDER)).filter((n) => n.endsWith(".md")).length).toBe(2);
	});

	test("merges the loser into the canonical card (higher confidence wins)", async () => {
		await ingestRecords(
			[
				rec({ id: "flux:cfg-distilled-a", title: "CFG guidance ignored on distilled flux2", detail: DUPE_DETAIL_A, confidence: 0.9 }),
				rec({ id: "flux:cfg-distilled-b", title: "CFG guidance ignored on distilled flux2", detail: DUPE_DETAIL_B, confidence: 0.7 }),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "test" },
		);

		const res = await mergeDuplicates({ vaultPath: vault, threshold: 0.9, dryRun: false });
		expect(res.merged).toBe(1);
		expect(res.archived.length).toBe(1);

		// Canonical = higher confidence (a=0.9 > b=0.7) → survives in flat folder.
		const flat = readdirSync(join(vault, FOLDER)).filter((n) => n.endsWith(".md"));
		expect(flat).toContain("flux-cfg-distilled-a.md");
		expect(flat).not.toContain("flux-cfg-distilled-b.md");

		// Loser archived + marked superseded_by canonical id.
		const archived = readFileSync(join(vault, FOLDER, "_archive", "flux-cfg-distilled-b.md"), "utf8");
		expect(archived).toContain("status: superseded");
		expect(archived).toContain("superseded_by: \"flux:cfg-distilled-a\"");

		// Canonical carries the merge provenance alias.
		const canon = readFileSync(join(vault, FOLDER, "flux-cfg-distilled-a.md"), "utf8");
		expect(canon).toContain("merged: flux:cfg-distilled-b");
	});

	test("rewrites inbound [[loser]] links to point at the canonical card", async () => {
		// A third card links to the loser; after merge it must link to canonical.
		await ingestRecords(
			[
				rec({ id: "flux:cfg-distilled-a", title: "CFG guidance ignored on distilled flux2", detail: DUPE_DETAIL_A, confidence: 0.9 }),
				rec({ id: "flux:cfg-distilled-b", title: "CFG guidance ignored on distilled flux2", detail: DUPE_DETAIL_B, confidence: 0.7 }),
				// third card shares the argv tag so it links to both; it is NOT a dupe (different content).
				rec({
					id: "flux:other-gotcha",
					title: "A completely different flux gotcha about path safety and argument validation",
					detail: "Path safety validation rejects traversal sequences in the argument parser.",
					tags: ["argv", "path-safety"],
					confidence: 0.8,
				}),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "test" },
		);

		const before = readFileSync(join(vault, FOLDER, "flux-other-gotcha.md"), "utf8");
		expect(before).toContain("[[flux-cfg-distilled-b]]");

		const res = await mergeDuplicates({ vaultPath: vault, threshold: 0.9, dryRun: false });
		expect(res.merged).toBe(1);
		expect(res.linksRewritten).toBeGreaterThanOrEqual(1);

		const after = readFileSync(join(vault, FOLDER, "flux-other-gotcha.md"), "utf8");
		expect(after).toContain("[[flux-cfg-distilled-a]]");
		expect(after).not.toContain("[[flux-cfg-distilled-b]]");
	});
});

describe("mergeDuplicates — safety gate", () => {
	test("does NOT merge merely-related cards below threshold", async () => {
		await ingestRecords(
			[
				rec({
					id: "flux:cfg-distilled",
					title: "CFG guidance ignored on distilled flux2 klein transformers",
					detail: "Classifier-free guidance does not transfer to distilled one-step transformers.",
					confidence: 0.9,
				}),
				rec({
					id: "krea:i2i-strength",
					title: "Krea i2i strength controls source fidelity",
					detail: "The strength parameter controls how much the output follows the input image.",
					tags: ["krea"],
					confidence: 0.9,
				}),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "test" },
		);

		const res = await mergeDuplicates({ vaultPath: vault, threshold: 0.9, dryRun: false });
		expect(res.pairs.length).toBe(0);
		expect(res.merged).toBe(0);
		expect(readdirSync(join(vault, FOLDER)).filter((n) => n.endsWith(".md")).length).toBe(2);
	});
});

describe("findDuplicatePairs — determinism", () => {
	test("is deterministic across runs (same input → same pairs)", async () => {
		await ingestRecords(
			[
				rec({ id: "flux:cfg-a", title: "CFG guidance ignored on distilled flux2", detail: DUPE_DETAIL_A, confidence: 0.9 }),
				rec({ id: "flux:cfg-b", title: "CFG guidance ignored on distilled flux2", detail: DUPE_DETAIL_B, confidence: 0.7 }),
			],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "test" },
		);
		// Re-load snapshots by calling mergeDuplicates dry-run twice; the pair
		// selection (canonical/loser) must be stable.
		const a = await mergeDuplicates({ vaultPath: vault, threshold: 0.9, dryRun: true });
		const b = await mergeDuplicates({ vaultPath: vault, threshold: 0.9, dryRun: true });
		expect(b.pairs).toEqual(a.pairs);
	});
});
