/**
 * Tests for forge/gitea.ts — the Gitea/Forgejo REST adapter.
 *
 * Mirrors forge-github-rest.test.ts: pure mappers covered with plain payloads,
 * the client covered through the same mockFetch route table (per-(method,path)
 * canned responses, `seq` for ordered answers). No network.
 */
import { test, expect, describe } from "bun:test";
import {
	createGiteaClient,
	giteaDefaultApiBase,
	mapGiteaPullRequest,
	mapGiteaStatuses,
	toGiteaMergeStyle,
	type GiteaRestOptions,
} from "../src/forge/gitea.js";

describe("toGiteaMergeStyle", () => {
	test("rebase → rebase-merge (Gitea's superset enum); others verbatim", () => {
		expect(toGiteaMergeStyle("rebase")).toBe("rebase-merge");
		expect(toGiteaMergeStyle("merge")).toBe("merge");
		expect(toGiteaMergeStyle("squash")).toBe("squash");
	});
});

describe("giteaDefaultApiBase", () => {
	test("https + /api/v1, port preserved", () => {
		expect(giteaDefaultApiBase("git.example.com")).toBe("https://git.example.com/api/v1");
		expect(giteaDefaultApiBase("localhost:3200")).toBe("https://localhost:3200/api/v1");
	});
});

describe("mapGiteaPullRequest", () => {
	test("open + mergeable:true → OPEN/CLEAN with refs", () => {
		expect(
			mapGiteaPullRequest({ state: "open", mergeable: true, base: { ref: "main" }, head: { ref: "feat", sha: "a".repeat(40) } }),
		).toEqual({
			state: "OPEN",
			mergeState: "CLEAN",
			baseRefName: "main",
			headRefName: "feat",
			headRefOid: "a".repeat(40),
		});
	});

	test("closed + merged:true → MERGED; closed only → CLOSED", () => {
		expect(mapGiteaPullRequest({ state: "closed", merged: true, base: { ref: "main" }, head: { ref: "feat" } }).state).toBe("MERGED");
		expect(mapGiteaPullRequest({ state: "closed", merged: false, base: { ref: "main" }, head: { ref: "feat" } }).state).toBe("CLOSED");
	});

	test("mergeable:false → BLOCKED (conflicts and repo-blocked share the bucket)", () => {
		expect(mapGiteaPullRequest({ state: "open", mergeable: false, base: { ref: "main" }, head: { ref: "feat" } }).mergeState).toBe("BLOCKED");
	});

	test("mergeable:null → UNKNOWN (still computing — never guess CLEAN)", () => {
		expect(mapGiteaPullRequest({ state: "open", mergeable: null, base: { ref: "main" }, head: { ref: "feat" } }).mergeState).toBe("UNKNOWN");
	});

	test("garbage → OPEN/UNKNOWN + empty refs, never throws", () => {
		expect(mapGiteaPullRequest(null)).toEqual({
			state: "OPEN",
			mergeState: "UNKNOWN",
			baseRefName: "",
			headRefName: "",
			headRefOid: undefined,
		});
		expect(mapGiteaPullRequest("nope").mergeState).toBe("UNKNOWN");
		expect(mapGiteaPullRequest(42).state).toBe("OPEN");
	});
});

describe("mapGiteaStatuses", () => {
	test("bare array (the /statuses endpoint shape): success/failure/error buckets, rest pending", () => {
		const arr = [{ status: "success" }, { status: "failure" }, { status: "error" }, { status: "pending" }, { status: "weird" }];
		expect(mapGiteaStatuses(arr)).toEqual({ pass: 1, fail: 2, pending: 2 });
	});

	test("{statuses:[…]} shape accepted defensively", () => {
		expect(mapGiteaStatuses({ statuses: [{ status: "success" }] })).toEqual({ pass: 1, fail: 0, pending: 0 });
	});

	test("garbage/null → zero tally, never throws", () => {
		expect(mapGiteaStatuses(null)).toEqual({ pass: 0, fail: 0, pending: 0 });
		expect(mapGiteaStatuses("nope")).toEqual({ pass: 0, fail: 0, pending: 0 });
	});
});

/** Build a mock fetch with per-(method,path) canned responses (copied from
 *  forge-github-rest.test.ts — same transport signature). */
interface MockRoute {
	method: string;
	path: string;
	status?: number;
	body?: unknown;
	seq?: Array<{ status?: number; body?: unknown }>;
}
function mockFetch(routes: MockRoute[]): {
	fn: typeof fetch;
	calls: Array<{ method: string; origin: string; path: string; body?: string; headers?: Record<string, string> }>;
} {
	const calls: Array<{ method: string; origin: string; path: string; body?: string; headers?: Record<string, string> }> = [];
	const queues = routes.map((r) => (r.seq ? [...r.seq] : []));
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? init.body : undefined;
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		calls.push({ method, origin: url.origin, path: url.pathname + url.search, body, headers });
		const idx = routes.findIndex((r) => r.method === method && r.path === url.pathname + url.search);
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

const baseOpts = (fetchFn: typeof fetch): GiteaRestOptions => ({
	host: "git.example.com",
	owner: "o",
	repo: "r",
	token: "t",
	tokenKind: "GITEA_TOKEN env",
	fetchFn,
	sleep: noSleep,
});

describe("createGiteaClient", () => {
	const pull = {
		state: "open", mergeable: true,
		base: { ref: "main" }, head: { ref: "feat", sha: "a".repeat(40) },
	};

	test("prStatus: pull → statuses rollup; auth header uses the token scheme", async () => {
		const { fn, calls } = mockFetch([
			{ method: "GET", path: "/api/v1/repos/o/r/pulls/1", body: pull },
			{ method: "GET", path: "/api/v1/repos/o/r/commits/" + "a".repeat(40) + "/statuses", body: [{ status: "success" }, { status: "pending" }] },
		]);
		const s = await createGiteaClient(baseOpts(fn)).prStatus(1);
		expect(s).toEqual({
			state: "OPEN",
			mergeState: "CLEAN",
			baseRefName: "main",
			headRefName: "feat",
			headRefOid: "a".repeat(40),
			checks: { pass: 1, fail: 0, pending: 1 },
			// mergeSha intentionally absent — Gitea exposes no merge-commit SHA.
		});
		expect(s.mergeSha).toBeUndefined();
		// The token scheme must REPLACE the transport's Bearer default
		// (Headers lowercases field names).
		expect(calls[0].headers?.authorization).toBe("token t");
		expect(calls[0].headers?.accept).toBe("application/json");
	});

	test("prStatus: mergeable:null → one re-GET, still null → UNKNOWN", async () => {
		const { fn, calls } = mockFetch([
			{ method: "GET", path: "/api/v1/repos/o/r/pulls/1", seq: [{ body: { ...pull, mergeable: null } }, { body: { ...pull, mergeable: null } }] },
			{ method: "GET", path: "/api/v1/repos/o/r/commits/" + "a".repeat(40) + "/statuses", body: [] },
		]);
		const s = await createGiteaClient(baseOpts(fn)).prStatus(1);
		expect(s.mergeState).toBe("UNKNOWN");
		expect(calls.filter((c) => c.path.endsWith("/pulls/1"))).toHaveLength(2);
	});

	test("prStatus: mergeable:null → re-GET resolves → CLEAN", async () => {
		const { fn } = mockFetch([
			{ method: "GET", path: "/api/v1/repos/o/r/pulls/1", seq: [{ body: { ...pull, mergeable: null } }, { body: pull }] },
			{ method: "GET", path: "/api/v1/repos/o/r/commits/" + "a".repeat(40) + "/statuses", body: [] },
		]);
		expect((await createGiteaClient(baseOpts(fn)).prStatus(1)).mergeState).toBe("CLEAN");
	});

	test("prStatus: terminal-state PR skips the mergeable re-GET entirely (the #2087 github-rest twin)", async () => {
		// Closed/merged and closed-unmerged both settle on `state` — a terminal
		// PR's mergeability never matters, and the re-GET is pure latency an
		// already-merged retry pays per read.
		for (const terminal of [{ state: "closed", merged: true }, { state: "closed", merged: false }]) {
			let slept = 0;
			const { fn, calls } = mockFetch([{ method: "GET", path: "/api/v1/repos/o/r/pulls/1", body: { ...pull, mergeable: null, ...terminal } }]);
			const c = createGiteaClient({ ...baseOpts(fn), sleep: async () => { slept++; } });
			const s = await c.prStatus(1);
			expect(s.mergeState).toBe("UNKNOWN"); // terminal settles on state, not mergeState
			expect(slept).toBe(0);
			expect(calls.filter((x) => x.path.endsWith("/pulls/1"))).toHaveLength(1);
		}
	});

	test("prStatus: statuses endpoint failure → zero tally, snapshot still returned", async () => {
		const { fn } = mockFetch([
			{ method: "GET", path: "/api/v1/repos/o/r/pulls/1", body: pull },
			{ method: "GET", path: "/api/v1/repos/o/r/commits/" + "a".repeat(40) + "/statuses", status: 500, body: { message: "boom" } },
		]);
		const s = await createGiteaClient(baseOpts(fn)).prStatus(1);
		expect(s.checks).toEqual({ pass: 0, fail: 0, pending: 0 });
		expect(s.state).toBe("OPEN");
	});

	test("mergeNow: POST {Do:'rebase-merge'} for strategy rebase; deleteBranch via DELETE /branches/{name}", async () => {
		const mergedPull = { ...pull, state: "closed", merged: true };
		const { fn, calls } = mockFetch([
			{ method: "POST", path: "/api/v1/repos/o/r/pulls/1/merge", status: 200 },
			{ method: "GET", path: "/api/v1/repos/o/r/pulls/1", body: mergedPull },
			{ method: "DELETE", path: "/api/v1/repos/o/r/branches/feat", status: 204 },
		]);
		await createGiteaClient(baseOpts(fn)).mergeNow(1, "rebase", true);
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /api/v1/repos/o/r/pulls/1/merge",
			"GET /api/v1/repos/o/r/pulls/1",
			"DELETE /api/v1/repos/o/r/branches/feat",
		]);
		expect(JSON.parse(calls[0].body!)).toEqual({ Do: "rebase-merge" });
	});

	test("mergeNow: 404/422 on the branch DELETE tolerated (already gone)", async () => {
		const mergedPull = { ...pull, state: "closed", merged: true };
		for (const status of [404, 422]) {
			const { fn } = mockFetch([
				{ method: "POST", path: "/api/v1/repos/o/r/pulls/1/merge", status: 200 },
				{ method: "GET", path: "/api/v1/repos/o/r/pulls/1", body: mergedPull },
				{ method: "DELETE", path: "/api/v1/repos/o/r/branches/feat", status, body: { message: "branch already deleted" } },
			]);
			await expect(createGiteaClient(baseOpts(fn)).mergeNow(1, "merge", true)).resolves.toBeUndefined();
		}
	});

	test("mergeNow: failure THROWS with the forge body text embedded", async () => {
		const { fn } = mockFetch([
			{ method: "POST", path: "/api/v1/repos/o/r/pulls/1/merge", status: 422, body: { message: "merge style is disabled" } },
		]);
		await expect(createGiteaClient(baseOpts(fn)).mergeNow(1, "squash", false)).rejects.toThrow(/HTTP 422.*merge style is disabled/);
	});

	test("prList('merged'): filters closed-unmerged, paginates at 50/page, slices to limit", async () => {
		const mergedRow = (n: number) => ({ number: n, head: { ref: `feat/${n}` }, merged_at: `2026-08-0${(n % 9) + 1}T00:00:00Z` });
		const unmergedRow = (n: number) => ({ number: n, head: { ref: `feat/${n}` }, merged_at: null });
		const { fn, calls } = mockFetch([
			{ method: "GET", path: "/api/v1/repos/o/r/pulls?state=closed&limit=50&page=1", body: [mergedRow(1), unmergedRow(2), mergedRow(3)] },
		]);
		const rows = await createGiteaClient(baseOpts(fn)).prList("merged", 10);
		expect(rows).toEqual([
			{ number: 1, headRefName: "feat/1", mergedAt: expect.any(String) },
			{ number: 3, headRefName: "feat/3", mergedAt: expect.any(String) },
		]);
		expect(calls[0].path).toBe("/api/v1/repos/o/r/pulls?state=closed&limit=50&page=1");
	});

	test("prList('merged'): pages past a FULL 50-row page, stops on a short page", async () => {
		const row = (n: number, merged = true) => ({ number: n, head: { ref: `feat/${n}` }, merged_at: merged ? "2026-08-01T00:00:00Z" : null });
		const { fn, calls } = mockFetch([
			{
				method: "GET",
				path: "/api/v1/repos/o/r/pulls?state=closed&limit=50&page=1",
				body: Array.from({ length: 50 }, (_, i) => row(i + 1, i % 2 === 0)), // 25 merged
			},
			{
				method: "GET",
				path: "/api/v1/repos/o/r/pulls?state=closed&limit=50&page=2",
				body: [row(101), row(102, false)],
			},
		]);
		const rows = await createGiteaClient(baseOpts(fn)).prList("merged", 200);
		expect(rows).toHaveLength(26);
		expect(calls.filter((c) => c.method === "GET")).toHaveLength(2); // short page stopped paging
	});

	test("prList('open'): state=open, keeps every row", async () => {
		const { fn } = mockFetch([
			{ method: "GET", path: "/api/v1/repos/o/r/pulls?state=open&limit=50&page=1", body: [{ number: 7, head: { ref: "feat/7" } }] },
		]);
		const rows = await createGiteaClient(baseOpts(fn)).prList("open");
		expect(rows).toEqual([{ number: 7, headRefName: "feat/7", mergedAt: undefined }]);
	});

	test("prList: fork rows with a null head ref are skipped", async () => {
		const { fn } = mockFetch([
			{ method: "GET", path: "/api/v1/repos/o/r/pulls?state=closed&limit=50&page=1", body: [{ number: 1, head: {}, merged_at: "x" }] },
		]);
		expect(await createGiteaClient(baseOpts(fn)).prList("merged")).toEqual([]);
	});

	test("apiBase override honored (GITEA_API_BASE for http instances)", async () => {
		const { fn, calls } = mockFetch([
			{ method: "GET", path: "/api/v1/repos/o/r/pulls/1", body: pull },
		]);
		const opts = { ...baseOpts(fn), apiBase: "http://localhost:3200/api/v1" };
		await createGiteaClient(opts).prStatus(1);
		expect(calls[0].origin).toBe("http://localhost:3200");
		expect(calls[0].path).toBe("/api/v1/repos/o/r/pulls/1");
	});

	test("default apiBase is https://<host>/api/v1", async () => {
		const { fn, calls } = mockFetch([
			{ method: "GET", path: "/api/v1/repos/o/r/pulls/1", body: pull },
		]);
		await createGiteaClient(baseOpts(fn)).prStatus(1);
		expect(calls[0].origin).toBe("https://git.example.com");
	});
});
