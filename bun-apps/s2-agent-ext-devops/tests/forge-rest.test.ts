/**
 * forge-rest.test.ts — the shared REST transport contract:
 * auth headers, JSON decode, and the error discipline (body text embedded in
 * the message for callers that grep it; the token value NEVER in output).
 */
import { describe, expect, test } from "bun:test";
import { createRestTransport, ForgeHttpError, ForgeNetworkError } from "../src/forge/rest.js";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

describe("createRestTransport", () => {
	test("GET happy path: headers + JSON decode", async () => {
		let seen: { url: string; method: string; headers: Record<string, string> } | undefined;
		const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen = { url, method: (init?.method ?? "GET").toUpperCase(), headers };
			return jsonResponse(200, { ok: true, n: 3 });
		}) as unknown as typeof fetch;
		const t = createRestTransport({ baseUrl: "https://api.example.com", token: "sekrit", tokenKind: "test", fetchFn });
		const out = await t.request<{ ok: boolean; n: number }>("GET", "/x");
		expect(out).toEqual({ ok: true, n: 3 });
		expect(seen!.url).toBe("https://api.example.com/x");
		expect(seen!.method).toBe("GET");
		expect(seen!.headers.Authorization).toBe("Bearer sekrit");
		expect(seen!.headers.Accept).toBe("application/vnd.github+json");
		expect(seen!.headers["Content-Type"]).toBeUndefined(); // no body → no content-type
	});

	test("PUT sends a JSON body", async () => {
		let seen: { method: string; contentType?: string; body?: string } | undefined;
		const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen = { method: (init?.method ?? "GET").toUpperCase(), contentType: headers["Content-Type"], body: typeof init?.body === "string" ? init.body : undefined };
			return jsonResponse(200, {});
		}) as unknown as typeof fetch;
		const t = createRestTransport({ baseUrl: "https://api.example.com", token: "t", tokenKind: "k", fetchFn });
		await t.request("PUT", "/pulls/1/merge", { merge_method: "squash" });
		expect(seen!.method).toBe("PUT");
		expect(seen!.contentType).toBe("application/json");
		expect(JSON.parse(seen!.body!)).toEqual({ merge_method: "squash" });
	});

	test("non-2xx → ForgeHttpError with status + body text IN THE MESSAGE", async () => {
		const fetchFn = (async () => jsonResponse(405, { message: "Pull Request is not mergeable" })) as unknown as typeof fetch;
		const t = createRestTransport({ baseUrl: "https://api.example.com", token: "t", tokenKind: "k", fetchFn });
		try {
			await t.request("PUT", "/pulls/1/merge");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ForgeHttpError);
			const http = err as ForgeHttpError;
			expect(http.status).toBe(405);
			expect(http.message).toContain("HTTP 405");
			expect(http.message).toContain("Pull Request is not mergeable"); // grep-able
			// TOKEN DISCIPLINE: the token value must never leak.
			expect(http.message).not.toContain("t="); // trivial guard; the token is single-char here
		}
	});

	test("fetch throw → ForgeNetworkError, message carries cause not token", async () => {
		const fetchFn = (async () => {
			throw new Error("dns went away");
		}) as unknown as typeof fetch;
		const t = createRestTransport({ baseUrl: "https://api.example.com", token: "sekrit-value", tokenKind: "k", fetchFn });
		try {
			await t.request("GET", "/x");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ForgeNetworkError);
			expect((err as Error).message).toContain("dns went away");
			expect((err as Error).message).not.toContain("sekrit-value");
		}
	});

	test("2xx with empty body → undefined; 2xx with non-JSON body → raw text", async () => {
		const empty = createRestTransport({
			baseUrl: "https://x.example.com",
			token: "t",
			tokenKind: "k",
			fetchFn: (async () => new Response("", { status: 204 })) as unknown as typeof fetch,
		});
		expect(await empty.request("DELETE", "/ref")).toBeUndefined();
		const raw = createRestTransport({
			baseUrl: "https://x.example.com",
			token: "t",
			tokenKind: "k",
			fetchFn: (async () => new Response("plain-text-ok", { status: 200 })) as unknown as typeof fetch,
		});
		expect(await raw.request<string>("GET", "/x")).toBe("plain-text-ok");
	});
});
