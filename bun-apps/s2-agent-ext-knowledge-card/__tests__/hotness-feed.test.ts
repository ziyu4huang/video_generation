/**
 * hotness-feed.test.ts — context-lifecycle ticket 12 (D8).
 *
 * Pins the t11 USED-ledger feed contract: the pure replay into per-uri
 * aggregates (mirror of usageAggregates' shape), the bounded multiplier
 * m(h) = 1 + 0.1·h ∈ [1.0, 1.1] ⊆ the D8 [0.9, 1.1] envelope (neutral at
 * h=0 — the reconciliation of the ticket's acceptance criteria: stale decay
 * → 1.0 AND never-used byte-identical), and the retrieveRecords integration
 * (flat + semantic lanes: monotonicity, default-OFF byte-identity, trace
 * honesty, usageLedgerPath override).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	usedLedgerAggregates,
	hotnessMultiplier,
	usedLedgerMultiplier,
} from "../src/feedback/hotness-feed.ts";
import { appendUsageRows, readUsageLedgerFile, type UsageRow } from "../src/feedback/usage.ts";
import { hotnessScore, HOTNESS_ALPHA_MAX } from "../src/hotness.ts";

const DAY = 86_400_000;

function row(uri: string, atMs: number): UsageRow {
	return { uri, at: new Date(atMs).toISOString(), via: "turn_end" };
}

describe("usedLedgerAggregates — the t11 ledger replay (usageAggregates' shape)", () => {
	test("one row = one use; max ts wins; keyed by uri; absent = never-used", () => {
		const t0 = Date.parse("2026-08-20T00:00:00Z");
		const t1 = Date.parse("2026-08-28T00:00:00Z");
		const agg = usedLedgerAggregates([row("a", t0), row("a", t1), row("a", t0), row("b", t1)]);
		expect(agg.get("a")).toEqual({ activeCount: 3, lastUsedAtMs: t1 });
		expect(agg.get("b")).toEqual({ activeCount: 1, lastUsedAtMs: t1 });
		expect(agg.has("c")).toBe(false); // missing = never-used → multiplier 1.0
	});

	test("an unparseable `at` still counts as a use but never wins the max", () => {
		const t1 = Date.parse("2026-08-28T00:00:00Z");
		const agg = usedLedgerAggregates([
			{ uri: "a", at: "not-a-date", via: "bus" },
			row("a", t1),
		]);
		expect(agg.get("a")).toEqual({ activeCount: 2, lastUsedAtMs: t1 });
	});

	test("empty ledger → empty map (all-neutral, never an error)", () => {
		expect(usedLedgerAggregates([]).size).toBe(0);
	});
});

describe("hotnessMultiplier — the D8 bound (ticket 12)", () => {
	test("neutral at h=0 (never-used AND fully-stale keep their score), +10% at h=1", () => {
		expect(hotnessMultiplier(0)).toBe(1);
		expect(hotnessMultiplier(1)).toBeCloseTo(1 + HOTNESS_ALPHA_MAX, 12);
		expect(hotnessMultiplier(0.5)).toBeCloseTo(1.05, 12);
	});

	test("monotone non-decreasing in h", () => {
		let prev = hotnessMultiplier(0);
		for (let h = 0.01; h <= 1.0001; h += 0.01) {
			const m = hotnessMultiplier(h);
			expect(m).toBeGreaterThanOrEqual(prev);
			prev = m;
		}
	});

	test("PROPERTY: multiplier ∈ [0.9, 1.1] for every hotnessScore output", () => {
		const now = Date.parse("2026-08-29T00:00:00Z");
		for (let n = 0; n <= 50; n++) {
			for (const ageDays of [0, 0.5, 1, 3, 7, 14, 30, 90, 365, 3650]) {
				const h = hotnessScore(n, now - ageDays * DAY, now);
				const m = hotnessMultiplier(h);
				expect(m).toBeGreaterThanOrEqual(0.9);
				expect(m).toBeLessThanOrEqual(1.1);
			}
		}
	});

	test("stale decay → neutral: 10-year-old heavy use multiplies by ~1.0", () => {
		const now = Date.parse("2026-08-29T00:00:00Z");
		const m = usedLedgerMultiplier(
			usedLedgerAggregates([row("a", now - 3650 * DAY)]),
			"a",
			"any-stem",
			now,
		);
		expect(m).toBeCloseTo(1, 6); // h ≈ 0 → m ≈ 1.0 (decays to neutral, never punitive)
	});

	test("uri-keyed first, stem fallback, absent → 1.0", () => {
		const now = Date.parse("2026-08-29T00:00:00Z");
		const agg = usedLedgerAggregates([row("id-a", now), row("stem-b", now)]);
		expect(usedLedgerMultiplier(agg, "id-a", "whatever", now)).toBeGreaterThan(1);
		// id miss, stem hit (cards whose id is the slug / pre-source_id era)
		expect(usedLedgerMultiplier(agg, "unrelated", "stem-b", now)).toBeGreaterThan(1);
		expect(usedLedgerMultiplier(agg, "unrelated", "also-unrelated", now)).toBe(1);
	});
});

describe("retrieveRecords × used-ledger hotness — integration (ticket 12)", () => {
	let vault: string;
	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kcard-hotness-feed-"));
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	async function ingest(ids: string[], tags: string[] = ["argv", "extra"]) {
		const { ingestRecords } = await import("../src/ingest.ts");
		const { rec, FOLDER } = await import("./helpers/hotness-fixtures.ts");
		await ingestRecords(
			ids.map((id) => rec(id, id === "top" ? [...tags, "third"] : tags)),
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "t12", folder: FOLDER, mocPath: `${FOLDER}/MOC.md` },
		);
		return FOLDER;
	}

	test("default (no hotness option) ignores the ledger entirely — byte-identical OFF lane", async () => {
		const { retrieveRecords } = await import("../src/retrieve.ts");
		const FOLDER = await ingest(["a", "b"]);
		// A ledger that WOULD change ranking (hot + recent) + a poisoned read
		// path: write a valid ledger, then assert the default lane is
		// unaffected by it AND by an unparseable one.
		const now = Date.now();
		appendUsageRows(vault, [row("t08:a", now), row("t08:a", now)]);
		const withLedger = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], includeTrace: true });
		writeFileSync(join(vault, ".knowledge-usage.jsonl"), "{torn json\n");
		const withTorn = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], includeTrace: true });
		expect(withLedger.cards.map((c) => c.id)).toEqual(["t08:a", "t08:b"]);
		expect(withLedger.trace?.options.hotnessLedger).toBeUndefined();
		expect(withTorn.cards.map((c) => c.id)).toEqual(["t08:a", "t08:b"]);
	});

	test("hotness:true + empty ledger → byte-identical ranking AND scores (regression pin)", async () => {
		const { retrieveRecords } = await import("../src/retrieve.ts");
		const FOLDER = await ingest(["a", "b", "c"]);
		const off = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], includeTrace: true });
		const on = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], hotness: true, includeTrace: true,
		});
		expect(on.cards.map((c) => c.id)).toEqual(off.cards.map((c) => c.id));
		expect(on.trace?.cards.map((c) => c.score)).toEqual(off.trace?.cards.map((c) => c.score));
		expect(on.trace?.hotnessLedgerUsed).toBe(true); // ran (over an empty map = no-op)
		expect(on.trace?.options.hotnessLedger).toBe(true);
	});

	test("monotonicity: used+recent tie beats cold tie; strictly-higher score keeps rank 1", async () => {
		const { retrieveRecords } = await import("../src/retrieve.ts");
		const FOLDER = await ingest(["tie-hot", "tie-cold", "top"]);
		const now = Date.parse("2026-08-29T12:00:00Z");
		appendUsageRows(vault, [
			row("t08:tie-hot", now - 3 * DAY),
			row("t08:tie-hot", now - 1 * DAY),
			row("t08:tie-hot", now),
		]);
		const r = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv", "extra", "third"], topK: 3,
			hotness: true, _hotnessNowMs: now, includeTrace: true,
		});
		expect(r.cards[0]!.title).toBe("top"); // D8: a 1-tag gap is never displaced (3 vs 2: 3·1.0 > 2×1.1)
		expect(r.cards.slice(1).map((c) => c.title)).toEqual(["tie-hot", "tie-cold"]);
		// The hot tie's score is exactly base × m(h) — bounded reward.
		const h = hotnessScore(3, now, now);
		const hot = r.trace!.cards.find((c) => c.id === "t08:tie-hot")!;
		const cold = r.trace!.cards.find((c) => c.id === "t08:tie-cold")!;
		expect(hot.score / cold.score).toBeCloseTo(hotnessMultiplier(h), 6); // equal base scores
	});

	test("stale usage decays to neutral: a 90-day-old ledger moves scores by < 0.01%", async () => {
		const { retrieveRecords } = await import("../src/retrieve.ts");
		const FOLDER = await ingest(["tie-hot", "tie-cold"]);
		const now = Date.parse("2026-08-29T12:00:00Z");
		appendUsageRows(vault, [row("t08:tie-hot", now - 90 * DAY)]);
		const off = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv", "extra"], includeTrace: true,
		});
		const on = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv", "extra"], hotness: true,
			_hotnessNowMs: now, includeTrace: true,
		});
		// Decay is ASYMPTOTIC to neutral (ticket: "multiplier → 1.0 as age → ∞"):
		// 90d under the 7d half-life → m−1 < 1e-4, so scores match to 4dp. A
		// strict tie can still flip at m barely >1 — bounded, never punitive.
		for (let i = 0; i < on.trace!.cards.length; i++) {
			expect(on.trace!.cards[i]!.score).toBeCloseTo(off.trace!.cards[i]!.score, 4);
		}
		const m = usedLedgerMultiplier(usedLedgerAggregates([row("t08:tie-hot", now - 90 * DAY)]), "t08:tie-hot", "", now);
		expect(m - 1).toBeLessThan(1e-4);
	});

	test("usageLedgerPath override + readUsageLedgerFile round-trip", async () => {
		const { retrieveRecords } = await import("../src/retrieve.ts");
		const FOLDER = await ingest(["tie-hot", "tie-cold"]);
		const now = Date.parse("2026-08-29T12:00:00Z");
		const altDir = mkdtempSync(join(tmpdir(), "kcard-used-ledger-alt-"));
		try {
			const altPath = join(altDir, "custom-ledger.jsonl");
			writeFileSync(altPath, `${JSON.stringify(row("t08:tie-hot", now))}\n`);
			expect(readUsageLedgerFile(altPath)).toEqual([row("t08:tie-hot", now)]);
			const r = await retrieveRecords({
				vaultPath: vault, folder: FOLDER, tags: ["argv", "extra"],
				hotness: true, usageLedgerPath: altPath, _hotnessNowMs: now,
			});
			// The vault-root ledger is empty; only the override file feeds.
			expect(r.cards[0]!.title).toBe("tie-hot");
		} finally {
			rmSync(altDir, { recursive: true, force: true });
		}
	});

	test("semantic lane: multiplier applied EXACTLY ONCE on the union pool (F1 precedent)", async () => {
		const { retrieveRecords } = await import("../src/retrieve.ts");
		const FOLDER = await ingest(["cold", "hot"]);
		const emb = async (texts: string[]) => texts.map(() => [1, 0]); // constant: cosNorm collapses
		const now = Date.parse("2026-08-29T12:00:00Z");
		appendUsageRows(vault, [row("t08:hot", now), row("t08:hot", now - DAY)]);
		const base: Parameters<typeof retrieveRecords>[0] = {
			vaultPath: vault, folder: FOLDER, tags: ["argv"], queryText: "argv query",
			topK: 2, semantic: true, hier: false, _testEmbedder: emb, includeTrace: true,
			_hotnessNowMs: now,
		};
		const off = await retrieveRecords({ ...base });
		const on = await retrieveRecords({ ...base, hotness: true });
		expect(off.trace?.semanticUsed).toBe(true);
		expect(on.trace?.hotnessLedgerUsed).toBe(true);
		const s0 = new Map(off.trace!.cards.map((c) => [c.id, c.score]));
		const h = hotnessScore(2, now, now);
		for (const c of on.trace!.cards) {
			const expected = s0.get(c.id)! * (c.id === "t08:hot" ? hotnessMultiplier(h) : 1);
			expect(c.score).toBeCloseTo(expected, 6);
		}
		// D8 on the rank-norm pool: the lexical rank-1's 12/11 ≈ 1.091 gap is
		// NOT displaced — m(h)=1.086 at h(2 uses, fresh) < 1.091, and even
		// h→1 (m=1.1) only barely clears it. Feedback re-ranks, never dominates.
		expect(on.cards[0]!.title).toBe("cold");
		expect(on.trace!.cards.find((c) => c.id === "t08:hot")!.score)
			.toBeGreaterThan(off.trace!.cards.find((c) => c.id === "t08:hot")!.score);
	});
});
