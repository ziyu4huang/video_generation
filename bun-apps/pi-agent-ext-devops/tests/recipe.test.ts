/**
 * Tests for runMergeRecipe — the polling orchestration. Uses a scripted fake
 * GhClient + a fake clock/sleeper (sleep advances the clock) so the loop is
 * deterministic with no real gh/git/network. The decision math is covered by
 * pr-logic.test.ts; these pin the I/O sequencing + outcomes.
 */
import { test, expect, describe } from "bun:test";
import { runMergeRecipe, type GhClient } from "../src/recipe.js";
import type { PrState, MergeState, CheckTally } from "../src/pr-logic.js";

type Status = { state: PrState; mergeState: MergeState; checks: CheckTally; mergeSha?: string };

/** Scripted gh: returns statuses[i], then repeats the last when exhausted. */
function fakeGh(statuses: Status[]) {
	let i = 0;
	const calls = { enableAutoMerge: [] as Array<{ n: number; strategy: string; deleteBranch: boolean }>, rebase: [] as string[] };
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

	test("CLEAN + checks pass → enableAutoMerge called, then MERGED", async () => {
		const { client, calls } = fakeGh([
			{ state: "OPEN", mergeState: "CLEAN", checks: pass5 },
			{ state: "MERGED", mergeState: "CLEAN", checks: pass5, mergeSha: "def" },
		]);
		const r = await runMergeRecipe(baseOpts(client, fakeClock()));
		expect(r.merged).toBe(true);
		expect(calls.enableAutoMerge).toHaveLength(1);
		expect(calls.enableAutoMerge[0]).toMatchObject({ strategy: "rebase", deleteBranch: true });
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
