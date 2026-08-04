/**
 * Tests for runMergeRecipe — the polling orchestration. Uses a scripted fake
 * GhClient + a fake clock/sleeper (sleep advances the clock) so the loop is
 * deterministic with no real gh/git/network. The decision math is covered by
 * pr-logic.test.ts; these pin the I/O sequencing + outcomes, plus the live
 * onProgress streaming + abort-signal handling.
 */
import { test, expect, describe } from "bun:test";
import { runMergeRecipe, type GhClient } from "../src/recipe.js";
import type { PrState, MergeState, CheckTally } from "../src/pr-logic.js";

type Status = { state: PrState; mergeState: MergeState; checks: CheckTally; mergeSha?: string };

/** Scripted gh: returns statuses[i], then repeats the last when exhausted. */
function fakeGh(statuses: Status[], opts: { mergeNowThrows?: boolean } = {}) {
	let i = 0;
	const calls = {
		enableAutoMerge: [] as Array<{ n: number; strategy: string; deleteBranch: boolean }>,
		mergeNow: [] as Array<{ n: number; strategy: string; deleteBranch: boolean }>,
		rebase: [] as string[],
	};
	const client: GhClient = {
		async prStatus() {
			return statuses[Math.min(i, statuses.length - 1)] ?? statuses[0] ?? {
				state: "OPEN", mergeState: "UNKNOWN", checks: { pass: 0, fail: 0, pending: 0 },
			};
		},
		async enableAutoMerge(n, strategy, deleteBranch) {
			calls.enableAutoMerge.push({ n, strategy, deleteBranch });
			i++; // advance so the next poll sees the next status (merge→merged)
		},
		async mergeNow(n, strategy, deleteBranch) {
			calls.mergeNow.push({ n, strategy, deleteBranch });
			if (opts.mergeNowThrows) throw new Error("merge method not allowed on this repo");
			// success → the recipe returns merged immediately (no i advance needed).
		},
		async rebaseAndForcePush(branch) {
			calls.rebase.push(branch);
			i++;
		},
	};
	// prStatus also advances i so a "wait" scenario progresses through statuses.
	const rawPrStatus = client.prStatus.bind(client);
	client.prStatus = async () => {
		const s = statuses[Math.min(i, statuses.length - 1)];
		i++;
		return s;
	};
	void rawPrStatus;
	return { client, calls };
}

function fakeClock() {
	let now = 0;
	return { clock: { now: () => now }, sleeper: { async sleep(ms: number) { now += ms; } }, reset: () => { now = 0; } };
}

function baseOpts(gh: GhClient, fc: ReturnType<typeof fakeClock>) {
	return {
		prNumber: 1,
		strategy: "rebase" as const,
		deleteBranch: true,
		handleBehind: "rebase-force-push" as const,
		timeoutMs: 60_000,
		pollIntervalMs: 10_000,
		branch: "feat-x",
		gh,
		sleeper: fc.sleeper,
		clock: fc.clock,
	};
}

const pass5 = { pass: 5, fail: 0, pending: 0 };
const pending = { pass: 2, fail: 0, pending: 3 };

describe("runMergeRecipe", () => {
	test("MERGED on first poll → merged, no merge/rebase calls", async () => {
		const { client, calls } = fakeGh([{ state: "MERGED", mergeState: "CLEAN", checks: pass5, mergeSha: "abc123" }]);
		const fc = fakeClock();
		const r = await runMergeRecipe(baseOpts(client, fc));
		expect(r.merged).toBe(true);
		expect(r.mergeSha).toBe("abc123");
		expect(calls.enableAutoMerge).toHaveLength(0);
		expect(calls.rebase).toHaveLength(0);
	});

	test("CLEAN + checks pass → direct mergeNow, merged immediately (no extra poll)", async () => {
		// RCA fix: a single green+CLEAN status merges via direct mergeNow and
		// returns at once — it does NOT arm --auto + re-poll (which raced the
		// harness call budget and aborted mid-propagation when checks passed late).
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "CLEAN", checks: pass5 }]);
		const r = await runMergeRecipe(baseOpts(client, fakeClock()));
		expect(r.merged).toBe(true);
		expect(r.finalState).toBe("MERGED");
		expect(calls.mergeNow).toHaveLength(1);
		expect(calls.mergeNow[0]).toMatchObject({ strategy: "rebase", deleteBranch: true });
		expect(calls.enableAutoMerge).toHaveLength(0); // direct merge, not --auto
	});

	test("direct mergeNow rejected (merge-queue repo) → falls back to enableAutoMerge, then MERGED", async () => {
		const { client, calls } = fakeGh(
			[
				{ state: "OPEN", mergeState: "CLEAN", checks: pass5 },
				{ state: "MERGED", mergeState: "CLEAN", checks: pass5, mergeSha: "def" },
			],
			{ mergeNowThrows: true },
		);
		const r = await runMergeRecipe(baseOpts(client, fakeClock()));
		expect(r.merged).toBe(true);
		expect(calls.mergeNow).toHaveLength(1); // tried direct first
		expect(calls.enableAutoMerge).toHaveLength(1); // fell back to --auto
	});

	test("BEHIND + handleBehind=rebase-force-push → rebase called, then MERGED", async () => {
		const { client, calls } = fakeGh([
			{ state: "OPEN", mergeState: "BEHIND", checks: pass5 },
			{ state: "MERGED", mergeState: "CLEAN", checks: pass5 },
		]);
		const r = await runMergeRecipe(baseOpts(client, fakeClock()));
		expect(r.merged).toBe(true);
		expect(r.behind).toBe(true);
		expect(calls.rebase).toEqual(["feat-x"]);
	});

	test("BEHIND + handleBehind=fail → not merged, behind=true, NO rebase", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "BEHIND", checks: pass5 }]);
		const opts = { ...baseOpts(client, fakeClock()), handleBehind: "fail" as const };
		const r = await runMergeRecipe(opts);
		expect(r.merged).toBe(false);
		expect(r.behind).toBe(true);
		expect(r.error).toMatch(/BEHIND/i);
		expect(calls.rebase).toHaveLength(0);
	});

	test("BEHIND rebase FAILURE → clean error outcome (not throw, not silent spin/abort)", async () => {
		// RCA #1009: a failing rebase (dirty tree/conflict/rejected push) must
		// surface as a clean error — not crash the tool (throw) and not spin
		// silently until the harness reports an opaque "aborted".
		const client: GhClient = {
			async prStatus() {
				return { state: "OPEN", mergeState: "BEHIND", checks: pass5 };
			},
			async enableAutoMerge() { /* unused */ },
			async mergeNow() { /* unused */ },
			async rebaseAndForcePush() {
				throw new Error("git rebase origin/main failed (exit 1): unstaged changes");
			},
		};
		const r = await runMergeRecipe(baseOpts(client, fakeClock()));
		expect(r.merged).toBe(false);
		expect(r.aborted).not.toBe(true);
		expect(r.timedOut).toBe(false);
		expect(r.behind).toBe(true);
		expect(r.error).toMatch(/rebase\+force-push failed/i);
		expect(r.error).toMatch(/unstaged changes/);
	});

	test("a failing check → not merged, NO auto-merge enabled", async () => {
		const { client, calls } = fakeGh([{ state: "OPEN", mergeState: "BLOCKED", checks: { pass: 4, fail: 1, pending: 0 } }]);
		const r = await runMergeRecipe(baseOpts(client, fakeClock()));
		expect(r.merged).toBe(false);
		expect(r.error).toMatch(/failing/i);
		expect(calls.enableAutoMerge).toHaveLength(0);
	});

	test("stays pending past timeout → timedOut=true", async () => {
		const { client } = fakeGh([{ state: "OPEN", mergeState: "BLOCKED", checks: pending }]);
		const opts = { ...baseOpts(client, fakeClock()), timeoutMs: 25_000, pollIntervalMs: 10_000 };
		const r = await runMergeRecipe(opts);
		expect(r.merged).toBe(false);
		expect(r.timedOut).toBe(true);
	});
});

describe("runMergeRecipe — live progress + abort", () => {
	test("calls onProgress once per poll with elapsed, poll#, state, checks, action", async () => {
		const { client } = fakeGh([
			{ state: "OPEN", mergeState: "BLOCKED", checks: pending },
			{ state: "OPEN", mergeState: "BLOCKED", checks: pending },
			{ state: "MERGED", mergeState: "CLEAN", checks: pass5, mergeSha: "abc" },
		]);
		const fc = fakeClock();
		const updates: Array<Record<string, unknown>> = [];
		const r = await runMergeRecipe({ ...baseOpts(client, fc), onProgress: (u) => updates.push(u as unknown as Record<string, unknown>) });
		expect(r.merged).toBe(true);
		expect(updates).toHaveLength(3); // one per poll
		expect(updates[0].pollNumber).toBe(1);
		expect(updates[2].pollNumber).toBe(3);
		expect(updates[0].action).toBe("wait");
		expect(updates[2].action).toBe("done");
		expect(updates[0].checks).toEqual(pending);
		expect(typeof updates[0].elapsedMs).toBe("number");
		expect((updates[2].elapsedMs as number) > (updates[0].elapsedMs as number)).toBe(true);
		expect(updates[0].behind).toBe(false);
	});

	test("outcome includes elapsedMs (for the final Took footer)", async () => {
		const { client } = fakeGh([{ state: "MERGED", mergeState: "CLEAN", checks: pass5, mergeSha: "x" }]);
		const r = await runMergeRecipe(baseOpts(client, fakeClock()));
		expect(r.merged).toBe(true);
		expect(typeof r.elapsedMs).toBe("number");
		expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	test("returns aborted when the signal is already aborted before the first poll", async () => {
		const ac = new AbortController();
		ac.abort();
		const { client } = fakeGh([{ state: "MERGED", mergeState: "CLEAN", checks: pass5, mergeSha: "x" }]);
		const r = await runMergeRecipe({ ...baseOpts(client, fakeClock()), signal: ac.signal });
		expect(r.merged).toBe(false);
		expect(r.aborted).toBe(true);
	});

	test("stops and returns aborted when the signal aborts between polls", async () => {
		const ac = new AbortController();
		const { client } = fakeGh([
			{ state: "OPEN", mergeState: "BLOCKED", checks: pending },
			{ state: "MERGED", mergeState: "CLEAN", checks: pass5, mergeSha: "x" },
		]);
		let sleeps = 0;
		const sleeper = { async sleep() { if (++sleeps >= 1) ac.abort(); } };
		const r = await runMergeRecipe({ ...baseOpts(client, fakeClock()), sleeper, signal: ac.signal });
		expect(r.merged).toBe(false);
		expect(r.aborted).toBe(true);
	});
});
