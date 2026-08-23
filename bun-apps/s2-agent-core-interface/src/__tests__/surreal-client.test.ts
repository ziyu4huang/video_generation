import { describe, it, expect, mock } from "bun:test";
import { SurrealClient, SURREAL_DEFAULTS, type SurrealFetch } from "../surreal-client.js";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("SurrealClient", () => {
  it("posts SurrealQL with LET bindings and returns the last statement result", async () => {
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8000/sql");
      const headers = init!.headers as Record<string, string>;
      expect(headers["surreal-ns"]).toBe("user_alice");
      expect(headers["surreal-db"]).toBe("memory");
      expect(headers["Authorization"]).toMatch(/^Basic /);
      const body = String(init!.body);
      expect(body).toContain('LET $name = "alice";');
      expect(body).toContain("RETURN $name;");
      return okJson([
        { result: "alice", status: "OK", time: "0ns" },
        { result: ["alice"], status: "OK", time: "0ns" },
      ]);
    });
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "user_alice", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as SurrealFetch,
    });
    const rows = await client.query<string[]>("RETURN $name;", { name: "alice" });
    expect(rows).toEqual(["alice"]);
  });

  it("throws on a statement whose status is not OK", async () => {
    const fetchMock = mock(async () => okJson([{ status: "ERR", result: "Table missing", time: "0ns" }]));
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "user_alice", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as SurrealFetch,
    });
    await expect(client.query("SELECT * FROM nope;")).rejects.toThrow("Table missing");
  });

  it("retries on 5xx then succeeds", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls++;
      if (calls < 3) return new Response("", { status: 503 });
      return okJson([{ result: [{ ok: true }], status: "OK", time: "0ns" }]);
    });
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "user_alice", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as SurrealFetch,
      backoffMs: 1, maxAttempts: 3,
    });
    const rows = await client.query("SELECT 1;");
    expect(rows).toEqual([{ ok: true }]);
    expect(calls).toBe(3);
  });

  it("retries on connection failure then throws after maxAttempts", async () => {
    const fetchMock = mock(async () => { throw new TypeError("fetch failed"); });
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "user_alice", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as SurrealFetch,
      backoffMs: 1, maxAttempts: 2,
    });
    await expect(client.query("SELECT 1;")).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails fast (bounded) when a request hangs — no infinite stall, timeout not retried", async () => {
    // A hung surrealdb round-trip must not stall the caller forever. Without a
    // per-request timeout the fetch below never resolves and the test hangs.
    // With the guard, AbortSignal.timeout fires -> a clear timeout error within
    // a bounded window, and the timeout is NOT retried (a stuck server would
    // just multiply the bound).
    // The mock must HONOR the abort signal (a real fetch observes it and
    // rejects on timeout). A bare `new Promise(()=>{})` ignores the signal
    // and would hang even with the guard — so wire the abort -> reject.
    const fetchMock = mock((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never resolves (no signal = truly hung)
        if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
        else signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      }));
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "user_alice", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as SurrealFetch,
      backoffMs: 1, maxAttempts: 3, requestTimeoutMs: 25,
    });
    const t0 = Date.now();
    await expect(client.query("SELECT 1;")).rejects.toThrow(/timeout/i);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // bounded, not infinite
    expect(fetchMock).toHaveBeenCalledTimes(1); // timeout is fail-fast, not retried
  });

  it("fires the injectable onRoundTrip hook once per query and never without one", async () => {
    const fetchMock = mock(async () => okJson([{ result: 1, status: "OK", time: "0ns" }]));
    const hook = mock(() => {});
    const withHook = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "user_alice", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as SurrealFetch,
      onRoundTrip: hook,
    });
    await withHook.query("RETURN 1;");
    await withHook.query("RETURN 1;");
    expect(hook).toHaveBeenCalledTimes(2); // once per query() call (hermes: bumpRoundTrips)
    // No hook configured: still works (hook is optional).
    const bare = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "user_alice", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as SurrealFetch,
    });
    await bare.query("RETURN 1;");
  });

  it("SURREAL_DEFAULTS pins the embedded local-service endpoint + root credentials", () => {
    expect(SURREAL_DEFAULTS).toEqual({ endpoint: "http://127.0.0.1:8000", username: "root", password: "root" });
  });
});
