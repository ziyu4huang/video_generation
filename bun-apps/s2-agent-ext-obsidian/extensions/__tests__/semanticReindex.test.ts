import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { maybeTriggerReindex } from "../../src/obsidian-lib.ts";

const BASE = "http://127.0.0.1:8000";

beforeEach(() => {
	delete process.env.VAULT_MIND_AUTO_REINDEX;
	delete process.env.VAULT_MIND_BASE_URL;
});

afterEach(() => {
	delete process.env.VAULT_MIND_AUTO_REINDEX;
	delete process.env.VAULT_MIND_BASE_URL;
});

test("disabled by default: no HTTP issued", async () => {
	// Declare the fetch arg signature so the double satisfies the helper's
	// `typeof fetch`-shaped injectable without a runtime change.
	const fetchMock = mock((_url: string, _init: RequestInit) => Promise.resolve(new Response("{}")));
	await maybeTriggerReindex("s2-agent-vault", "/v", {
		fetch: fetchMock as unknown as typeof fetch,
		base: BASE,
	});
	expect(fetchMock).not.toHaveBeenCalled();
});

test("disabled by denylist values (0/false/off/no, case-insensitive): no HTTP issued", async () => {
	const fetchMock = mock((_url: string, _init: RequestInit) => Promise.resolve(new Response("{}")));
	for (const v of ["0", "false", "off", "no", "OFF", "No"]) {
		process.env.VAULT_MIND_AUTO_REINDEX = v;
		await maybeTriggerReindex("s2-agent-vault", "/v", {
			fetch: fetchMock as unknown as typeof fetch,
			base: BASE,
		});
	}
	expect(fetchMock).not.toHaveBeenCalled();
});

test("enabled + base set: POSTs /api/index with force_reindex:true", async () => {
	process.env.VAULT_MIND_AUTO_REINDEX = "1";
	const fetchMock = mock((_url: string, _init: RequestInit) =>
		Promise.resolve(new Response('{"job_id":"j1"}', { status: 200 })),
	);
	await maybeTriggerReindex("s2-agent-vault", "/v", {
		fetch: fetchMock as unknown as typeof fetch,
		base: BASE,
	});
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const call = fetchMock.mock.calls[0];
	expect(call).toBeDefined();
	const [url, init] = call as [string, RequestInit];
	expect(String(url)).toContain("/api/index");
	expect(init.method).toBe("POST");
	const body = JSON.parse(String(init.body));
	expect(body).toMatchObject({ vault_name: "s2-agent-vault", force_reindex: true });
});

test("service down: warns, does not throw into caller", async () => {
	process.env.VAULT_MIND_AUTO_REINDEX = "1";
	const fetchMock = mock((_url: string, _init: RequestInit) => Promise.reject(new Error("ECONNREFUSED")));
	await expect(
		maybeTriggerReindex("s2-agent-vault", "/v", {
			fetch: fetchMock as unknown as typeof fetch,
			base: BASE,
		}),
	).resolves.toBeUndefined();
});
