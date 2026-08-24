/**
 * rebuild-automation.test.ts — the ticket 10 reconciliation port (from the
 * parallel t08 branch): the post-write index-rebuild trigger's contract and
 * the retrieve boundary's usage-ledger echo.
 *
 * scheduleCardRebuild is unit-tested through its `_clientOpts` fetch seam —
 * NEVER the production path (makeContextClient targets the live per-user
 * context_db; a temp-vault rebuild would fingerprint the temp tree and swap
 * the LIVE index to it — that is exactly why the env kill-switch exists and
 * why the tool/CLI test suites set it).
 *
 * The usage echo is tested through the `_usageClient` seam with a recording
 * fake (same pattern as hotness.test.ts); hermetic suites never touch a real
 * SurrealDB.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleCardRebuild } from "../src/surreal-index.ts";
import { retrieveRecords } from "../src/retrieve.ts";
import { recordUsageBatch } from "../src/usage.ts";
import type { SurrealClient } from "@repo/s2-agent-core-interface";

const FOLDER = "Zettelkasten/knowledge-graph";

/** Deferred fetch — the first request parks on a gate the test releases, so
 *  concurrency and error paths are observable without any real endpoint. */
function deferredFetch() {
	const urls: string[] = [];
	let release!: (ok: boolean) => void;
	const gate = new Promise<boolean>((res) => {
		release = res;
	});
	const fetch = async (input: RequestInfo | URL): Promise<Response> => {
		urls.push(String(input));
		const ok = await gate;
		return ok
			? new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } })
			: new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
	};
	return { fetch, urls, release };
}

/** Recording fake over the SurrealClient seam (hotness.test.ts pattern). */
function fakeUsageClient() {
	const list: Array<{ sql: string; params: Record<string, unknown> }> = [];
	const client = {
		async query<T>(sql: string, params: Record<string, unknown> = {}): Promise<T> {
			list.push({ sql, params });
			return [] as unknown as T;
		},
	};
	return { client: client as unknown as SurrealClient, list };
}

function writeCard(vault: string, stem: string, tags: string): void {
	const dir = join(vault, FOLDER);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${stem}.md`), `---\nid: ${stem}\ntags: ${tags}\n---\n\nbody about argv injection quirks\n`);
}

describe("scheduleCardRebuild — the post-write trigger contract", () => {
	let savedKill: string | undefined;
	beforeEach(() => {
		savedKill = process.env.KCARD_INDEX_REBUILD;
		delete process.env.KCARD_INDEX_REBUILD;
	});
	afterEach(() => {
		if (savedKill === undefined) delete process.env.KCARD_INDEX_REBUILD;
		else process.env.KCARD_INDEX_REBUILD = savedKill;
	});

	test("kill-switch KCARD_INDEX_REBUILD=0 resolves null WITHOUT touching the endpoint", async () => {
		process.env.KCARD_INDEX_REBUILD = "0";
		let called = 0;
		const r = await scheduleCardRebuild({
			vaultPath: "/nonexistent",
			_clientOpts: {
				fetch: (async () => {
					called += 1;
					throw new Error("must not be called");
				}) as unknown as typeof fetch,
			},
		});
		expect(r).toBeNull();
		expect(called).toBe(0);
	});

	test("concurrent triggers COALESCE onto one in-flight rebuild (same promise, one request)", async () => {
		const { fetch, urls, release } = deferredFetch();
		const opts = {
			vaultPath: mkdtempSync(join(tmpdir(), "kcard-rebuild-")),
			_clientOpts: { fetch: fetch as unknown as typeof fetch, maxAttempts: 1, backoffMs: 1 },
		};
		try {
			const p1 = scheduleCardRebuild(opts);
			const p2 = scheduleCardRebuild(opts);
			expect(p2).toBe(p1); // coalesced — literally the same in-flight promise
			await new Promise((r) => setTimeout(r, 20));
			expect(urls.length).toBe(1); // ensureContextDb's query — one request, not two
			release(false); // server error → SurrealClient throws
			expect(await p1).toBeNull(); // NON-FATAL: a failed rebuild resolves null
			expect(await p2).toBeNull();
			// After the in-flight rebuild settles, the coalescing slot re-arms.
			const p3 = scheduleCardRebuild(opts);
			expect(p3).not.toBe(p1);
			release(false);
			expect(await p3).toBeNull();
		} finally {
			rmSync(opts.vaultPath, { recursive: true, force: true });
		}
	});
});

describe("retrieve usage echo — the production-boundary ledger write", () => {
	let vault: string;
	let savedKill: string | undefined;
	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kcard-echo-"));
		writeCard(vault, "argv-quirk-a", "[argv]");
		writeCard(vault, "argv-quirk-b", "[argv]");
		writeCard(vault, "unrelated-card", "[other]");
		savedKill = process.env.KCARD_USAGE_LOG;
		delete process.env.KCARD_USAGE_LOG;
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
		if (savedKill === undefined) delete process.env.KCARD_USAGE_LOG;
		else process.env.KCARD_USAGE_LOG = savedKill;
	});

	test("usageLog: true echoes the SERVED leaf stems in ONE batched query", async () => {
		const { client, list } = fakeUsageClient();
		const r = await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: ["argv"],
			topK: 10,
			usageLog: true,
			_usageClient: client,
		});
		expect(r.cards.length).toBeGreaterThanOrEqual(2);
		const writes = list.filter((q) => q.sql.startsWith("CREATE usage"));
		expect(writes.length).toBe(1); // one batched round trip, not topK
		const stems = [...r.cards.filter((c) => !c.viaTree).map((c) => c.path.split("/").pop()!)];
		for (const s of new Set(stems)) {
			expect(writes[0]!.sql).toContain(`$s${[...new Set(stems)].indexOf(s)}`); // numbered param per stem
			expect(Object.values(writes[0]!.params)).toContain(s);
		}
		expect(writes[0]!.params.kind).toBe("retrieve");
	});

	test("default OFF: bare library callers never write (hermetic contract)", async () => {
		const { client, list } = fakeUsageClient();
		await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: ["argv"], _usageClient: client });
		expect(list.length).toBe(0);
	});

	test("env kill-switch KCARD_USAGE_LOG=0 suppresses even the opted-in boundary", async () => {
		process.env.KCARD_USAGE_LOG = "0";
		const { client, list } = fakeUsageClient();
		await retrieveRecords({
			vaultPath: vault,
			folder: FOLDER,
			tags: ["argv"],
			usageLog: true,
			_usageClient: client,
		});
		expect(list.length).toBe(0);
	});
});

describe("recordUsageBatch", () => {
	test("empty stems → no query at all", async () => {
		const { client, list } = fakeUsageClient();
		await recordUsageBatch(client, [], "retrieve");
		expect(list.length).toBe(0);
	});

	test("N stems → ONE query carrying N CREATE statements", async () => {
		const { client, list } = fakeUsageClient();
		await recordUsageBatch(client, ["a", "b", "c"], "retrieve", new Date("2026-08-24T00:00:00Z"));
		expect(list.length).toBe(1);
		expect(list[0]!.sql.match(/CREATE usage/g)?.length).toBe(3);
		expect(list[0]!.params.s0).toBe("a");
		expect(list[0]!.params.s2).toBe("c");
		expect(list[0]!.params.kind).toBe("retrieve");
	});
});
