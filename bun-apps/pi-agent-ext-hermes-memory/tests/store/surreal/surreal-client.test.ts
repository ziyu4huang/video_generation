import { describe, it, expect, mock } from "bun:test";
import { SurrealClient } from "../../../src/store/surreal/surreal-client.js";

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
      username: "root", password: "root", fetch: fetchMock as unknown as typeof fetch,
    });
    const rows = await client.query<string[]>("RETURN $name;", { name: "alice" });
    expect(rows).toEqual(["alice"]);
  });

  it("throws on a statement whose status is not OK", async () => {
    const fetchMock = mock(async () => okJson([{ status: "ERR", result: "Table missing", time: "0ns" }]));
    const client = new SurrealClient({
      endpoint: "http://127.0.0.1:8000", namespace: "user_alice", database: "memory",
      username: "root", password: "root", fetch: fetchMock as unknown as typeof fetch,
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
      username: "root", password: "root", fetch: fetchMock as unknown as typeof fetch,
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
      username: "root", password: "root", fetch: fetchMock as unknown as typeof fetch,
      backoffMs: 1, maxAttempts: 2,
    });
    await expect(client.query("SELECT 1;")).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
