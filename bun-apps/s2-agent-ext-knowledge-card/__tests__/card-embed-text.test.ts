/**
 * card-embed-text.test.ts — the embed-text composition red tests
 * (kcard-quality-lift T1 / planner D1).
 *
 * Measured baseline these tests pin: the vector used to be title + tags +
 * first 800 chars of body, with the frontmatter summary stripped and 連結/
 * meta scaffolding INCLUDED — the MRR 0.153 root cause. Now: summary is
 * carried in, scaffolding is stripped, and the body window reaches deep
 * content (2400 body / 3000 total).
 */
import { describe, expect, test } from "bun:test";
import { EMBED_BODY_CHARS, EMBED_TOTAL_CHARS, cardEmbedText } from "../src/semantic.ts";

const FIXTURE_CARD = `---
id: 202609092218
created: 2026-09-09
tags: [zettel, gpu, memory-safety, benchmark]
sources: ["arXiv:2609.08871"]
summary: GMSBench is a GPU memory-safety benchmark of 149 self-contained CUDA tests.
---

# Paper - GMSBench GPU 記憶體安全標準化評測

## 核心想法
- GMSBench comprises 149 self-contained CUDA tests spanning spatial, temporal, and concurrency error classes.

## 證據 / 脈絡
- Authors span Georgia Tech, Microsoft, and NVIDIA (p.1).

${"x".repeat(1500)}

- Deep-body fact: the racecheck detector found 12 of the 51 reported races (Table 7, p.4).

## 連結
- 相關：[[Paper - Some Other Card]]
`;

describe("cardEmbedText — embed composition (T1)", () => {
	test("frontmatter summary is carried into the embed text", () => {
		const t = cardEmbedText(FIXTURE_CARD, "Paper - GMSBench GPU 記憶體安全標準化評測", ["gpu", "memory-safety"]);
		expect(t).toContain("GMSBench is a GPU memory-safety benchmark");
	});

	test("deep-body content beyond the old 800-char slice is included", () => {
		const t = cardEmbedText(FIXTURE_CARD, "Paper - GMSBench", ["gpu"]);
		expect(t).toContain("racecheck detector found 12 of the 51 reported races");
	});

	test("連結 section and record-meta lines are stripped", () => {
		const t = cardEmbedText(FIXTURE_CARD, "Paper - GMSBench", ["gpu"]);
		expect(t).not.toContain("Some Other Card");
		expect(t).not.toContain("source_id:");
		expect(t).not.toContain("provenance:");
	});

	test("the duplicated H1 is stripped (title already leads the embed)", () => {
		const t = cardEmbedText(FIXTURE_CARD, "Paper - GMSBench", ["gpu"]);
		expect(t.startsWith("Paper - GMSBench. gpu")).toBe(true);
		expect(t.match(/# Paper - GMSBench/g)).toBeNull();
	});

	test("total embed text respects the 3000-char cap", () => {
		const big = FIXTURE_CARD.replace("x".repeat(1500), "y".repeat(6000));
		const t = cardEmbedText(big, "Paper - GMSBench", ["gpu"]);
		expect(t.length).toBeLessThanOrEqual(EMBED_TOTAL_CHARS);
		expect(EMBED_BODY_CHARS).toBe(2400);
	});
});
