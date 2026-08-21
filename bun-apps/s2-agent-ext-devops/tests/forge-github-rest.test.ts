/**
 * forge-github-rest.test.ts — the GitHub REST adapter: pure mappers
 * (mapPullRequest / mapChecksRollup) fully covered, plus the client flows
 * (prStatus incl. the mergeable:null re-GET, mergeNow, deleteBranch two-op)
 * against a mock fetch.
 */
import { describe, expect, test } from "bun:test";
import { mapPullRequest, mapChecksRollup, createGithubRestClient } from "../src/forge/github-rest.js";
import type { MergeState } from "../src/pr-logic.js";

describe("mapPullRequest (REST → PrSnapshot core)", () => {
	const base = { base: { ref: "main" }, head: { ref: "feat", sha: "a".repeat(40) } };

	test("open + clean → OPEN/CLEAN with headRefOid", () => {
		const out = mapPullRequest({ ...base, state: "open", mergeable: true, mergeable_state: "clean", merge_commit_sha: "b".repeat(40) });
		expect(out).toEqual({
			state: "OPEN",
			mergeState: "CLEAN",
			mergeSha: "b".repeat(40),
			baseRefName: "main",
			headRefName: "feat",
			headRefOid: "a".repeat(40),
		});
	});

	test("closed + merged_at → MERGED; closed without → CLOSED", () => {
		expect(mapPullRequest({ ...base, state: "closed", merged_at: "2026-01-01" }).state).toBe("MERGED");
		expect(mapPullRequest({ ...base, state: "closed" }).state).toBe("CLOSED");
	});

	test("mergeable_state ladder maps onto MergeState", () => {
		const cases: Array<[string, MergeState]> = [
			["clean", "CLEAN"], ["behind", "BEHIND"], ["blocked", "BLOCKED"],
			["dirty", "DIRTY"], ["unstable", "UNSTABLE"], ["has_hooks", "HAS_HOOKS"],
			["unknown", "UNKNOWN"],
		];
		for (const [raw, want] of cases) {
			expect(mapPullRequest({ ...base, state: "open", mergeable: true, mergeable_state: raw }).mergeState).toBe(want);
		}
	});

	test("mergeable:null forces UNKNOWN even when mergeable_state claims clean", () => {
		const out = mapPullRequest({ ...base, state: "open", mergeable: null, mergeable_state: "clean" });
		expect(out.mergeState).toBe("UNKNOWN");
	});

	test("missing/unknown mergeable_state → UNKNOWN; garbage input never throws", () => {
		expect(mapPullRequest({ ...base, state: "open", mergeable: true }).mergeState).toBe("UNKNOWN");
		expect(mapPullRequest({ ...base, state: "open", mergeable: true, mergeable_state: "brand_new_state" }).mergeState).toBe("UNKNOWN");
		expect(mapPullRequest(null)).toEqual({
			state: "OPEN", mergeState: "UNKNOWN", mergeSha: undefined, baseRefName: "", headRefName: "", headRefOid: undefined,
		});
	});
});

describe("mapChecksRollup (check-runs ∪ statuses)", () => {
	test("check-run classification: status field decides pending, conclusion decides pass/fail", () => {
		const runs = {
			check_runs: [
				{ status: "completed", conclusion: "success" },
				{ status: "completed", conclusion: "skipped" },
				{ status: "completed", conclusion: "neutral" },
				{ status: "completed", conclusion: "failure" },
				{ status: "completed", conclusion: "timed_out" },
				{ status: "in_progress" },
				{ status: "queued" },
				{ status: "completed" }, // completed but no conclusion yet — pending
				{ status: "weird" }, // unknown shape — never claim success
			],
		};
		expect(mapChecksRollup(runs, null)).toEqual({ pass: 3, fail: 2, pending: 4 });
	});

	test("statuses half: success/failure/pending + union with check-runs", () => {
		const statuses = { statuses: [{ state: "success" }, { state: "failure" }, { state: "pending" }, { state: "weird" }] };
		expect(mapChecksRollup(null, statuses)).toEqual({ pass: 1, fail: 1, pending: 2 });
		const runs = { check_runs: [{ status: "completed", conclusion: "success" }] };
		expect(mapChecksRollup(runs, statuses)).toEqual({ pass: 2, fail: 1, pending: 2 });
	});

	test("garbage inputs → zero tally, never throws", () => {
		expect(mapChecksRollup(null, null)).toEqual({ pass: 0, fail: 0, pending: 0 });
		expect(mapChecksRollup("nope", 42)).toEqual({ pass: 0, fail: 0, pending: 0 });
	});
});

/** Build a mock fetch with per-(method,path) canned responses. The transport
 *  calls fetch(url, init) — NOT a Request object — so the mock matches that
 *  signature (url string + init carrying method/body). A route with `seq`
 *  answers those IN ORDER before falling back to its static body/status. */
interface MockRoute {
	method: string;
	path: string;
	status?: number;
	body?: unknown;
	seq?: Array<{ status?: number; body?: unknown }>;
}
function mockFetch(routes: MockRoute[]): {
	fn: typeof fetch;
	calls: Array<{ method: string; path: string; body?: string }>;
} {
	const calls: Array<{ method: string; path: string; body?: string }> = [];
	const queues = routes.map((r) => (r.seq ? [...r.seq] : []));
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? init.body : undefined;
		calls.push({ method, path: url.pathname, body });
		const idx = routes.findIndex((r) => r.method === method && r.path === url.pathname);
		const route = routes[idx];
		if (!route) return new Response(JSON.stringify({ message: `no route for ${method} ${url.pathname}` }), { status: 404 });
		let status = route.status ?? 200;
		let out = route.body;
		const next = queues[idx]!.shift();
		if (next) {
			status = next.status ?? 200;
			out = next.body;
		}
		return new Response(out === undefined ? "" : JSON.stringify(out), { status });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

const noSleep = async () => {};

describe("createGithubRestClient", () => {
	const pull = {
		state: "open", mergeable: true, mergeable_state: "clean",
		base: { ref: "main" }, head: { ref: "feat", sha: "a".repeat(40) },
		merge_commit_sha: "b".repeat(40),
	};

	test("prStatus: pull → check-runs ∪ status rollup", async () => {
		const { fn, calls } = mockFetch([
			{ method: "GET", path: "/repos/o/r/pulls/7", body: pull },
			{ method: "GET", path: `/repos/o/r/commits/${"a".repeat(40)}/check-runs`, body: { check_runs: [{ status: "completed", conclusion: "success" }] } },
			{ method: "GET", path: `/repos/o/r/commits/${"a".repeat(40)}/status`, body: { statuses: [{ state: "pending" }] } },
		]);
		const c = createGithubRestClient({ owner: "o", repo: "r", token: "t", tokenKind: "k", fetchFn: fn, sleep: noSleep });
		const s = await c.prStatus(7);
		expect(s.state).toBe("OPEN");
		expect(s.mergeState).toBe("CLEAN");
		expect(s.checks).toEqual({ pass: 1, fail: 0, pending: 1 });
		expect(calls.length).toBe(3);
	});

	test("prStatus: mergeable:null → ONE re-GET then settle", async () => {
		const computing = { ...pull, mergeable: null, mergeable_state: "" };
		const { fn, calls } = mockFetch([
			// First GET still computing; the re-GET resolves clean (seq).
			{
				method: "GET", path: "/repos/o/r/pulls/7",
				seq: [{ body: computing }, { body: pull }],
			},
			{ method: "GET", path: `/repos/o/r/commits/${"a".repeat(40)}/check-runs`, body: { check_runs: [] } },
			{ method: "GET", path: `/repos/o/r/commits/${"a".repeat(40)}/status`, body: { statuses: [] } },
		]);
		const c = createGithubRestClient({ owner: "o", repo: "r", token: "t", tokenKind: "k", fetchFn: fn, sleep: noSleep });
		const s = await c.prStatus(7);
		expect(s.mergeState).toBe("CLEAN"); // resolved on the re-GET, no UNKNOWN round-trip
		expect(calls.filter((x) => x.path.endsWith("/pulls/7")).length).toBe(2);
	});

	test("prStatus: still-computing after re-GET → UNKNOWN (settlePrStatus owns the rest)", async () => {
		const computing = { ...pull, mergeable: null };
		const { fn } = mockFetch([{ method: "GET", path: "/repos/o/r/pulls/7", body: computing }]);
		const c = createGithubRestClient({ owner: "o", repo: "r", token: "t", tokenKind: "k", fetchFn: fn, sleep: noSleep });
		const s = await c.prStatus(7);
		expect(s.mergeState).toBe("UNKNOWN");
	});

	test("prStatus: check endpoints failing → zero tally, snapshot still returned", async () => {
		const { fn } = mockFetch([{ method: "GET", path: "/repos/o/r/pulls/7", body: pull }]);
		const c = createGithubRestClient({ owner: "o", repo: "r", token: "t", tokenKind: "k", fetchFn: fn, sleep: noSleep });
		const s = await c.prStatus(7);
		expect(s.state).toBe("OPEN");
		expect(s.checks).toEqual({ pass: 0, fail: 0, pending: 0 });
	});

	test("mergeNow: 200 is the merge; deleteBranch adds the ref delete (two ops)", async () => {
		const { fn, calls } = mockFetch([
			{ method: "PUT", path: "/repos/o/r/pulls/7/merge", body: { sha: "c".repeat(40) } },
			{ method: "GET", path: "/repos/o/r/pulls/7", body: pull },
			{ method: "DELETE", path: "/repos/o/r/git/refs/heads/feat", status: 204 },
		]);
		const c = createGithubRestClient({ owner: "o", repo: "r", token: "t", tokenKind: "k", fetchFn: fn, sleep: noSleep });
		await c.mergeNow(7, "squash", true);
		expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
			"PUT /repos/o/r/pulls/7/merge",
			"GET /repos/o/r/pulls/7",
			"DELETE /repos/o/r/git/refs/heads/feat",
		]);
		expect(JSON.parse(calls[0]!.body as string)).toEqual({ merge_method: "squash" });
	});

	test("mergeNow: failure throws with the response body embedded (workflow-scope grep)", async () => {
		const { fn } = mockFetch([
			{ method: "PUT", path: "/repos/o/r/pulls/7/merge", status: 403, body: { message: "Refusing to allow an OAuth App to create or update workflow" } },
		]);
		const c = createGithubRestClient({ owner: "o", repo: "r", token: "t", tokenKind: "k", fetchFn: fn, sleep: noSleep });
		try {
			await c.mergeNow(7, "squash", false);
			expect.unreachable();
		} catch (err) {
			expect((err as Error).message).toContain("Refusing to allow an OAuth App to create or update workflow");
		}
	});

	test("mergeNow: deleteBranch tolerates an already-deleted ref (422)", async () => {
		const { fn } = mockFetch([
			{ method: "PUT", path: "/repos/o/r/pulls/7/merge", body: {} },
			{ method: "GET", path: "/repos/o/r/pulls/7", body: pull },
			{ method: "DELETE", path: "/repos/o/r/git/refs/heads/feat", status: 422, body: { message: "Reference does not exist" } },
		]);
		const c = createGithubRestClient({ owner: "o", repo: "r", token: "t", tokenKind: "k", fetchFn: fn, sleep: noSleep });
		await c.mergeNow(7, "squash", true); // must NOT throw
	});
});
