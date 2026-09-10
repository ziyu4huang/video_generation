/**
 * production.test.ts — the PRODUCTION-faithful query lane (planner D1/D6,
 * blend-lift T1): golden questions flow through `inferQueryTags` +
 * `buildRetrieveOptions` + `retrieveRecords` — the exact symbols the
 * `knowledge_query` tool serves.
 *
 * Goldens v2 are CARD-GROUNDED (authored from the card files — protocol v2;
 * v1's paper-text authoring made 98% of questions unanswerable from the
 * vault, measured 2026-09-10). Measured baseline (embed tier, fresh vectors):
 * production MRR = 0.276 on card-grounded questions vs 0.138 on the flawed
 * paper-grounded set. Design gate 0.70 remains a target; the deterministic
 * suite asserts the floor + the never-ranked accounting.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openConvergedSandbox } from "../src/converge-sandbox.ts";
import { realVaultPath } from "../src/vault-sandbox.ts";
import { buildNoteMap } from "../src/lanes/query-gates.ts";
import { productionMrr } from "../src/lanes/production.ts";

const GOLDEN_V2 = join(import.meta.dir, "..", "fixtures", "golden-v2");
const CARDS_DIR = join(realVaultPath(), "Zettelkasten");

function loadV2() {
	return readdirSync(GOLDEN_V2)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => {
			const g = JSON.parse(readFileSync(join(GOLDEN_V2, f), "utf8"));
			return { ...g, arxivId: g.arxivId.replace(/^arXiv:/, "") };
		});
}

describe("production lane — card-grounded questions (embed tier)", () => {
	test("13 v2 goldens, all questions card-grounded", () => {
		expect(loadV2()).toHaveLength(13);
		for (const g of loadV2()) {
			expect(g.questions.filter((q: { answerable: boolean }) => q.answerable).length).toBeGreaterThanOrEqual(4);
		}
	});

	test("production-path MRR measured through the served boundary", async () => {
		if (process.env.BENCH_EMBED !== "1") {
			console.log("(skip) production MRR needs the embedding server — BENCH_EMBED=1 + LM Studio :1234");
			return;
		}
		const { vaultPath } = await openConvergedSandbox(realVaultPath(), CARDS_DIR);
		const noteMap = buildNoteMap(vaultPath, loadV2().map((g) => g.arxivId));
		const r = await productionMrr(vaultPath, loadV2(), noteMap);
		expect(r.questions).toBeGreaterThanOrEqual(13 * 4);
		// measured floor: 0.276 on 2026-09-10 — guards catastrophic regressions;
		// design gate 0.70 lives in the scorecard verdict.
		expect(r.mrr).toBeGreaterThanOrEqual(0.2);
		expect(r.mrr).toBeGreaterThanOrEqual(0.276 - 0.05); // run-to-run embed jitter band
		console.log(`[production] MRR=${r.mrr.toFixed(3)} hit@3=${r.hitAt3.toFixed(3)} never-ranked=${r.neverRanked.length}`);
	}, 180_000);
});
