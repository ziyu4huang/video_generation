/**
 * Ticket 15 (context-lifecycle D10) — retrieval-eval harness self-test.
 *
 * Two jobs, both CI-cheap (no network, no Surreal, no live embedder):
 *
 *   1. Pin the metric math (`src/eval/metrics.ts`) on HAND-COMPUTED fixtures —
 *      hit@k / MRR / token-cost aggregation, including the target-absent
 *      exclusion (t04 corpus-coverage discipline).
 *   2. Run the harness itself end-to-end on the inline fixture corpus with the
 *      forced mock embedder (spawn, like eval-gate.test.ts) — exit 0, receipt
 *      shape, and the four graded targets all retrievable.
 *
 * The LIVE modes (real corpus A/B, controlled corpus) stay opt-in via
 * `bun run test:eval` / the script's --help — never here (≤5-min local_ci).
 *
 * PORTABILITY-GUARDED: the end-to-end job spawns `bun` against the committed
 * harness script (fixture corpus, forced mock embedder — no network, no
 * Surreal, no LM Studio). bun + a committed repo script are present on every
 * CI runner and dev machine, so this spawn is CI-safe — it is NOT a
 * machine-coupled host-binary probe (test-portability-audit.test.ts's own
 * spawn pattern).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { computeMetrics, estimateTokens, firstHitRank } from "../src/eval/metrics.ts";

// ── 1. metric math on hand-computed fixtures ────────────────────────────────

describe("computeMetrics (hand-computed)", () => {
	test("ranks [1, 2, miss, 4] at k=4: hit@1=1 hit@3=2 hit@4=3 MRR=(1+0.5+0+0.25)/4", () => {
		const m = computeMetrics(
			[
				{ rank: 1, tokensRendered: 100, cardsReturned: 4 },
				{ rank: 2, tokensRendered: 100, cardsReturned: 4 },
				{ rank: 0, tokensRendered: 100, cardsReturned: 4 },
				{ rank: 4, tokensRendered: 100, cardsReturned: 4 },
			],
			4,
		);
		expect(m.graded).toBe(4);
		expect(m.hit1).toBe(1);
		expect(m.hit3).toBe(2);
		expect(m.hitK).toBe(3);
		expect(m.misses).toBe(1);
		expect(m.mrr).toBe(0.438); // 1.75/4 = 0.4375 → toFixed(3)
		expect(m.tokensPerQuery).toBe(100);
		expect(m.tokensPerCard).toBe(25); // 400 tokens / 16 cards
	});

	test("k truncates: rank 4 counts at k=4 but not k=3", () => {
		const outcomes = [{ rank: 4, tokensRendered: 10, cardsReturned: 4 }];
		expect(computeMetrics(outcomes, 4).hitK).toBe(1);
		expect(computeMetrics(outcomes, 3).hitK).toBe(0);
		expect(computeMetrics(outcomes, 3).mrr).toBe(0.25); // rank still counts for MRR
	});

	test("target-absent outcomes are counted separately, never scored", () => {
		const m = computeMetrics(
			[
				{ rank: 1, tokensRendered: 50, cardsReturned: 4 },
				{ rank: 0, tokensRendered: 50, cardsReturned: 4, targetAbsent: true },
			],
			4,
		);
		expect(m.graded).toBe(1);
		expect(m.absent).toBe(1);
		expect(m.hitK).toBe(1);
		expect(m.mrr).toBe(1);
	});

	test("empty battery zeroes rates instead of NaN", () => {
		const m = computeMetrics([], 4);
		expect(m.graded).toBe(0);
		expect(Number.isNaN(m.mrr)).toBe(false);
		expect(Number.isNaN(m.tokensPerQuery)).toBe(false);
	});

	test("token cost: per-query mean and per-card mean (denominator = cards returned)", () => {
		const m = computeMetrics(
			[
				{ rank: 1, tokensRendered: 120, cardsReturned: 2 },
				{ rank: 1, tokensRendered: 80, cardsReturned: 2 },
				{ rank: 0, tokensRendered: 0, cardsReturned: 0 }, // miss with no cards returned
			],
			4,
		);
		expect(m.tokensPerQuery).toBe(66.7); // 200/3
		expect(m.tokensPerCard).toBe(50); // 200 / 4 cards
	});
});

describe("firstHitRank / estimateTokens", () => {
	test("firstHitRank is 1-based, 0 on miss", () => {
		expect(firstHitRank(["a", "b", "c"], (x) => x === "b")).toBe(2);
		expect(firstHitRank(["a", "b", "c"], (x) => x === "z")).toBe(0);
		expect(firstHitRank([], () => true)).toBe(0);
	});
	test("estimateTokens is ceil(chars/4)", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});

// ── 2. harness end-to-end on the fixture corpus (offline, forced mock) ──────

describe("retrieval-eval.mjs fixture mode (offline)", () => {
	test("runs, reports all four graded targets, and writes a well-shaped receipt", () => {
		const script = join(import.meta.dir, "..", "scripts", "retrieval-eval.mjs");
		const tmp = join(tmpdir(), `kcard-retrieval-eval-test-${process.pid}`);
		mkdirSync(tmp, { recursive: true });
		const receiptPath = join(tmp, "receipt.json");
		try {
			const proc = spawnSync("bun", [script, "--receipt", receiptPath], { encoding: "utf8", timeout: 60_000 });
			expect(proc.status, proc.stderr).toBe(0);
			const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
			// meta records every dimension the A/B needs to be reproducible
			expect(receipt.meta).toMatchObject({ corpus: "fixture", k: 4, model: "bge-m3", blend: "semantic", tier: "abstract", hotness: "off", embedder: "test-hashing" });
			// the fixture battery is 4 graded + 1 negative; mock embedder forced
			expect(receipt.metrics.graded).toBe(4);
			expect(receipt.negatives).toHaveLength(1);
			expect(receipt.trace.semanticUsed).toBe(true);
			// every graded target retrievable at k=4 (distinctive tokens per card)
			expect(receipt.metrics.hitK).toBe(4);
			for (const p of receipt.perQuery) {
				expect(p.rank).toBeGreaterThanOrEqual(1);
				expect(p.tokensRendered).toBeGreaterThan(0);
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}, 90_000);
});
