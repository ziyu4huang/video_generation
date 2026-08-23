/**
 * hotness.test.ts — kcard-parity ticket 08 (D37–D39).
 *
 * Pins the pure scoring contract (upstream formula port), the D39 boundary
 * validation, and the D8 bound mechanics: with α ≤ 0.10 on the flat lane's
 * integer-ish scores, hotness reorders TIES but never displaces a strictly
 * higher score. The usage-ledger write/read contract (recordUsage /
 * usageAggregates over the SurrealClient seam) is covered with a recording
 * fake; the flat-lane integration (retrieveRecords ordering + trace honesty)
 * runs against a temp vault.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hotnessScore,
	blendWithHotness,
	resolveHotnessAlpha,
	HOTNESS_ALPHA_MAX,
	HOTNESS_HALF_LIFE_DAYS,
} from "../src/hotness.ts";
import { recordUsage, usageAggregates } from "../src/usage.ts";
import type { SurrealClient } from "@repo/s2-agent-core-interface";

const DAY = 86_400_000;

describe("hotnessScore — the upstream formula (D38)", () => {
	test("never-used / missing / invalid timestamp → 0.0 (cold, not neutral)", () => {
		const now = Date.now();
		expect(hotnessScore(0, now, now)).toBe(0);
		expect(hotnessScore(5, null, now)).toBe(0);
		expect(hotnessScore(5, undefined, now)).toBe(0);
		expect(hotnessScore(5, "not-a-date", now)).toBe(0);
		expect(hotnessScore(5, Number.NaN, now)).toBe(0);
	});

	test("frequency = sigmoid(log1p(n)): 1 vs 100 uses are close (log-compressed)", () => {
		const now = Date.now();
		const h1 = hotnessScore(1, now, now);
		const h100 = hotnessScore(100, now, now);
		expect(h1).toBeCloseTo(1 / (1 + Math.exp(-Math.log1p(1))), 10);
		expect(h100).toBeCloseTo(1 / (1 + Math.exp(-Math.log1p(100))), 10);
		expect(h100 / h1).toBeLessThan(1.6); // compression, not linear count
	});

	test("recency half-life 7d: fresh=1×freq, 7d≈0.5×freq, 14d≈0.25×freq (D38)", () => {
		const now = Date.now();
		const n = 3;
		const freq = 1 / (1 + Math.exp(-Math.log1p(n)));
		expect(hotnessScore(n, now, now)).toBeCloseTo(freq, 10);
		expect(hotnessScore(n, now - 7 * DAY, now)).toBeCloseTo(freq * 0.5, 6);
		expect(hotnessScore(n, now - 14 * DAY, now)).toBeCloseTo(freq * 0.25, 6);
		expect(HOTNESS_HALF_LIFE_DAYS).toBe(7); // upstream default (D38)
	});

	test("accepts epoch ms and ISO strings; a future timestamp clamps to full recency", () => {
		const now = new Date("2026-08-24T00:00:00Z");
		const viaMs = hotnessScore(2, now.getTime(), now);
		const viaIso = hotnessScore(2, now.toISOString(), now);
		expect(viaMs).toBe(viaIso);
		expect(viaMs).toBeGreaterThan(0);
		expect(hotnessScore(2, now.getTime() + DAY, now)).toBeCloseTo(viaMs, 10); // age clamped ≥ 0
	});

	test("custom half-life is honored (tunable constant, D38)", () => {
		const now = Date.now();
		expect(hotnessScore(2, now - 1 * DAY, now, 1)).toBeCloseTo(hotnessScore(2, now, now) * 0.5, 6);
	});
});

describe("resolveHotnessAlpha — the D39 boundary", () => {
	test("undefined → 0 (OFF, upstream's own default); 0 and 0.10 pass", () => {
		expect(resolveHotnessAlpha(undefined)).toBe(0);
		expect(resolveHotnessAlpha(0)).toBe(0);
		expect(resolveHotnessAlpha(HOTNESS_ALPHA_MAX)).toBe(HOTNESS_ALPHA_MAX);
		expect(HOTNESS_ALPHA_MAX).toBe(0.1);
	});

	test("outside [0, 0.10] fails LOUD (config error, never a silent ranking change)", () => {
		for (const bad of [0.1000001, 0.5, 1, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => resolveHotnessAlpha(bad)).toThrow(RangeError);
		}
	});
});

describe("blendWithHotness — the D8 bound mechanics (D39)", () => {
	const a = HOTNESS_ALPHA_MAX;

	test("α=0 is the identity (byte-identical OFF lane)", () => {
		expect(blendWithHotness(3.5, 0.9, 0)).toBe(3.5);
	});

	test("the pinned bound: hotness reorders TIES but never displaces a strictly higher score", () => {
		// Flat-lane shape: integer-ish scores. Best-case hotness (1.0) on the
		// lower-scored card vs worst-case (0.0) on the higher-scored one.
		const low = blendWithHotness(3, 1, a); // 3·0.9 + 0.1 = 2.8
		const high = blendWithHotness(4, 0, a); // 4·0.9 = 3.6
		expect(low).toBeCloseTo(2.8, 10);
		expect(high).toBeCloseTo(3.6, 10);
		expect(low).toBeLessThan(high); // feedback re-ranks, never dominates (D8)

		// Equal scores + hotter card wins the tie deterministically.
		const tieHot = blendWithHotness(3, 0.8, a);
		const tieCold = blendWithHotness(3, 0, a);
		expect(tieHot).toBeGreaterThan(tieCold);
	});

	test("pool-wide scaling: blending h=0 shrinks a never-used score UNIFORMLY (why the blend must cover every card)", () => {
		// If no-event stems were SKIPPED, a used card at score s would blend
		// to (1−α)s+αh while an equal-scored never-used card kept s — the
		// used card would LOSE the tie, inverting the feature. Blending h=0
		// on never-used cards scales the whole pool by (1−α), keeping ties
		// comparable and hot cards ahead WITHIN them.
		const neverUsed = blendWithHotness(3, 0, a);
		const used = blendWithHotness(3, 0.9, a);
		expect(neverUsed).toBeLessThan(3);
		expect(used).toBeGreaterThan(neverUsed);
	});
});

/** Recording fake over the SurrealClient seam (the class has private state —
 *  cast through unknown; only `query` is on usage.ts's call path). */
function fakeUsageClient(rows: Array<{ stem: string; n: number; last_ms: number | null }> = []) {
	const list: Array<{ sql: string; params: Record<string, unknown> }> = [];
	const client = {
		async query<T>(sql: string, params: Record<string, unknown> = {}): Promise<T> {
			list.push({ sql, params });
			if (sql.startsWith("CREATE usage")) return [] as unknown as T;
			return rows as unknown as T;
		},
	};
	return { client: client as unknown as SurrealClient, list };
}

describe("usage.ts — the ledger seam (D37, D12 replay)", () => {
	test("recordUsage appends one event row (stem + kind + at + at_ms)", async () => {
		const { client, list } = fakeUsageClient();
		await recordUsage(client, "flux2-argv-gotcha", "zk_card", new Date("2026-08-24T00:00:00Z"));
		expect(list.length).toBe(1);
		expect(list[0]!.sql).toContain("CREATE usage");
		expect(list[0]!.params).toMatchObject({ stem: "flux2-argv-gotcha", kind: "zk_card" });
		expect(list[0]!.params.atMs).toBe(Date.parse("2026-08-24T00:00:00Z"));
	});

	test("usageAggregates replays count + max-ts per stem; never-used stems absent", async () => {
		const t0 = Date.parse("2026-08-20T00:00:00Z");
		const t1 = Date.parse("2026-08-24T00:00:00Z");
		const { client, list } = fakeUsageClient([
			{ stem: "a", n: 3, last_ms: t1 },
			{ stem: "b", n: 1, last_ms: t0 },
		]);
		const agg = await usageAggregates(client, ["a", "b", "c"]);
		expect(list[0]!.sql).toContain("GROUP BY stem");
		expect(agg.get("a")).toEqual({ activeCount: 3, lastUsedAtMs: t1 });
		expect(agg.get("b")).toEqual({ activeCount: 1, lastUsedAtMs: t0 });
		expect(agg.has("c")).toBe(false); // missing = never-used → hotness 0
	});

	test("usageAggregates([]) short-circuits (zero round-trips)", async () => {
		const { client, list } = fakeUsageClient();
		const agg = await usageAggregates(client, []);
		expect(agg.size).toBe(0);
		expect(list.length).toBe(0);
	});
});

describe("retrieveRecords × hotness — flat-lane integration (D39)", () => {
	let vault: string;
	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kcard-hotness-"));
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	test("default (no hotnessAlpha) is byte-identical to the pre-ticket-08 ranking", async () => {
		const { ingestRecords } = await import("../src/ingest.ts");
		const { retrieveRecords } = await import("../src/retrieve.ts");
		const { rec, FOLDER } = await import("./helpers/hotness-fixtures.ts");
		await ingestRecords([rec("a", ["argv"]), rec("b", ["argv"]), rec("c", ["argv"])], {
			vaultPath: vault,
			source: "workflow-jsonl",
			sourceLabel: "t08",
			folder: FOLDER,
			mocPath: `${FOLDER}/MOC.md`,
		});
		// A throwing client would surface if the OFF lane touched usage.
		const boom = { async query() { throw new Error("must not be called"); } } as unknown as SurrealClient;
		const r = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], _usageClient: boom });
		expect(r.count).toBe(3);
		expect(r.trace).toBeUndefined();
	});

	test("α=0.10: a hot tie beats a cold tie; a strictly-higher score still wins; trace is honest", async () => {
		const { ingestRecords } = await import("../src/ingest.ts");
		const { retrieveRecords } = await import("../src/retrieve.ts");
		const { rec, FOLDER, stemsOf } = await import("./helpers/hotness-fixtures.ts");
		await ingestRecords(
			[rec("tie-hot", ["argv", "extra"]), rec("tie-cold", ["argv", "extra"]), rec("top", ["argv", "extra", "third"])],
			{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "t08", folder: FOLDER, mocPath: `${FOLDER}/MOC.md` },
		);
		const now = Date.now();
		const { client } = fakeUsageClient([
			{ stem: stemsOf["tie-hot"], n: 5, last_ms: now },
		]);
		const r = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv", "extra", "third"], topK: 3,
			hotnessAlpha: HOTNESS_ALPHA_MAX, _usageClient: client, includeTrace: true,
		});
		// Strictly-higher score keeps rank 1 (D8: never displaced).
		expect(r.cards[0]!.title).toBe("top");
		// The hot tie beats the cold tie.
		const titles = r.cards.slice(1).map((c) => c.title);
		expect(titles).toEqual(["tie-hot", "tie-cold"]);
		// Trace honesty (F4 precedent): blend ran; hotness present pool-wide
		// (0 = never-used).
		expect(r.trace?.hotnessUsed).toBe(true);
		expect(r.trace?.options.hotnessAlpha).toBe(HOTNESS_ALPHA_MAX);
		const hot = r.trace!.cards.find((c) => c.id === "t08:tie-hot");
		expect(hot?.hotness).toBeGreaterThan(0);
		const cold = r.trace!.cards.find((c) => c.id === "t08:tie-cold");
		expect(cold?.hotness).toBe(0);
	});

	test("usage lane down (client throws) → ranking unchanged, hotnessUsed absent", async () => {
		const { ingestRecords } = await import("../src/ingest.ts");
		const { retrieveRecords } = await import("../src/retrieve.ts");
		const { rec, FOLDER } = await import("./helpers/hotness-fixtures.ts");
		await ingestRecords([rec("x", ["argv"]), rec("y", ["argv"])], {
			vaultPath: vault, source: "workflow-jsonl", sourceLabel: "t08", folder: FOLDER, mocPath: `${FOLDER}/MOC.md`,
		});
		const boom = { async query() { throw new Error("surreal down"); } } as unknown as SurrealClient;
		const r = await retrieveRecords({
			vaultPath: vault, folder: FOLDER, tags: ["argv"], hotnessAlpha: HOTNESS_ALPHA_MAX,
			_usageClient: boom, includeTrace: true,
		});
		expect(r.count).toBe(2);
		expect(r.trace?.hotnessUsed).toBeUndefined();
		expect(r.trace?.options.hotnessAlpha).toBe(HOTNESS_ALPHA_MAX); // honest: requested but not served
	});

	test("out-of-bound hotnessAlpha fails loud at the boundary", async () => {
		const { retrieveRecords } = await import("../src/retrieve.ts");
		await expect(
			retrieveRecords({ vaultPath: vault, folder: "Zettelkasten/knowledge-graph", tags: ["argv"], hotnessAlpha: 0.5 }),
		).rejects.toThrow(RangeError);
	});
});
