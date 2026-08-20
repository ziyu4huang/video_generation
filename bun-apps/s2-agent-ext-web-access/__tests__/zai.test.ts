/**
 * zai.test.ts — unit tests for the Z.ai native search provider.
 *
 * Mocks globalThis.fetch (Z.ai MCP is HTTP JSON-RPC) and asserts:
 *   • availability tracks ZAI_API_KEY
 *   • tool discovery via tools/list
 *   • result parsing across 3 shapes (JSON array, SSE data:, Title:/URL: blocks)
 *   • quota exhaustion (HTTP 429) → ZaiQuotaError (so the auto chain can fall through)
 *
 * ( cd bun-apps/s2-agent-ext-web-access && bun test )
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
	searchWithZai,
	isZaiAvailable,
	ZaiQuotaError,
	_resetZaiToolCacheForTest,
} from "../zai.ts";

const ORIG_FETCH = globalThis.fetch;
const ORIG_KEY = process.env.ZAI_API_KEY;

function rpcResponse(result: unknown): string {
	return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
}

function makeResponse(body: string, status = 200, contentType = "application/json"): Response {
	return new Response(body, { status, headers: { "content-type": contentType } });
}

/** Build a fetch mock that answers tools/list then tools/call per the args. */
function mockFetch(opts: {
	toolName?: string;
	callText?: string;
	callStatus?: number;
	callBody?: string;
	asSSE?: boolean;
}): typeof fetch {
	return (async (_input: unknown, init?: RequestInit) => {
		const parsed = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
		if (parsed.method === "tools/list") {
			return makeResponse(rpcResponse({ tools: [{ name: opts.toolName ?? "web_search_exa" }] }));
		}
		// tools/call
		if (opts.callStatus && opts.callStatus !== 200) {
			return makeResponse(opts.callBody ?? "rate limit exceeded", opts.callStatus);
		}
		const inner = rpcResponse({ content: [{ type: "text", text: opts.callText ?? "" }] });
		if (opts.asSSE) {
			return makeResponse(`data: ${inner}\n\n`, 200, "text/event-stream");
		}
		return makeResponse(inner);
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	process.env.ZAI_API_KEY = "test-key";
	_resetZaiToolCacheForTest();
});

afterEach(() => {
	globalThis.fetch = ORIG_FETCH;
	if (ORIG_KEY === undefined) delete process.env.ZAI_API_KEY;
	else process.env.ZAI_API_KEY = ORIG_KEY;
	_resetZaiToolCacheForTest();
});

test("isZaiAvailable tracks ZAI_API_KEY", () => {
	process.env.ZAI_API_KEY = "abc";
	expect(isZaiAvailable()).toBe(true);
	delete process.env.ZAI_API_KEY;
	expect(isZaiAvailable()).toBe(false);
});

test("searchWithZai parses a JSON-array result", async () => {
	globalThis.fetch = mockFetch({
		callText: JSON.stringify([
			{ title: "T1", url: "https://x.test/a", snippet: "S1" },
			{ title: "T2", url: "https://x.test/b" },
		]),
	});
	const res = await searchWithZai("hello", { numResults: 2 });
	expect(res).not.toBeNull();
	expect(res!.results.length).toBe(2);
	expect(res!.results[0].url).toBe("https://x.test/a");
	expect(res!.results[0].snippet).toBe("S1");
});

test("searchWithZai parses an SSE data: reply", async () => {
	globalThis.fetch = mockFetch({
		callText: JSON.stringify([{ title: "T", url: "https://x.test/sse" }]),
		asSSE: true,
	});
	const res = await searchWithZai("hello");
	expect(res!.results[0].url).toBe("https://x.test/sse");
});

test("searchWithZai parses Title:/URL: block format", async () => {
	globalThis.fetch = mockFetch({
		callText:
			"Title: A\nURL: https://x.test/c\nText: content here\n\n" +
			"Title: B\nURL: https://x.test/d\nText: more content",
	});
	const res = await searchWithZai("hello");
	expect(res!.results.length).toBe(2);
	expect(res!.results[0].url).toBe("https://x.test/c");
	expect(res!.results[1].title).toBe("B");
});

test("HTTP 429 throws ZaiQuotaError (so the auto chain can fall through)", async () => {
	globalThis.fetch = mockFetch({ callStatus: 429, callBody: "rate limit exceeded" });
	await expect(searchWithZai("hello")).rejects.toBeInstanceOf(ZaiQuotaError);
});

test("quota-looking MCP error message throws ZaiQuotaError", async () => {
	globalThis.fetch = (async () =>
		makeResponse(JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			error: { code: -32000, message: "insufficient credit" },
		}))) as unknown as typeof fetch;
	// tools/list itself fails with a quota error here.
	await expect(searchWithZai("hello")).rejects.toBeInstanceOf(ZaiQuotaError);
});

test("explicit provider name is discovered via tools/list (no hard-coded name)", async () => {
	let seenMethods: string[] = [];
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		const parsed = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
		seenMethods.push(parsed.method ?? "");
		if (parsed.method === "tools/list") {
			return makeResponse(rpcResponse({ tools: [{ name: "zai_web_search_prime_tool" }] }));
		}
		return makeResponse(rpcResponse({
			content: [{ type: "text", text: JSON.stringify([{ title: "X", url: "https://x.test/dynamic" }]) }],
		}));
	}) as unknown as typeof fetch;
	const res = await searchWithZai("hello");
	expect(seenMethods).toContain("tools/list");
	expect(seenMethods).toContain("tools/call");
	expect(res!.results[0].url).toBe("https://x.test/dynamic");
});
