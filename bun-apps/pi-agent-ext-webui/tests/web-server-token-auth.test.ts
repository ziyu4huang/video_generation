/**
 * web-server-token-auth.test.ts — ticket 07 D1: the OPTIONAL token-auth
 * mechanism on WebServer. null => no check (v1 loopback); non-null => every
 * request must present the token (?session= for GET + WS-URL; body.token for
 * POST), flat !==, 403 on mismatch. The origin guard runs FIRST regardless.
 *
 * All servers bind port 0 (ephemeral); every started server is stopped in
 * afterEach. Real HTTP via the global fetch() (same pattern as the origin-guard
 * tests in web-server.test.ts). The origin-guard 403 body is "forbidden"
 * (lowercase); the token-block 403 body is "Forbidden" (capital F) — tests
 * assert the body to confirm WHICH check fired (proves ordering).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";

const started: WebServer[] = [];
function makeServer(): WebServer {
  const s = new WebServer({ port: 0 });
  started.push(s);
  return s;
}
afterEach(() => {
  while (started.length) {
    const s = started.pop()!;
    try {
      s.stop();
    } catch {
      /* ignore */
    }
  }
});

describe("WebServer token auth (setTokenAuth, ticket 07 D1)", () => {
  it("default (never set) => token null => GET passes WITHOUT ?session=", async () => {
    const s = makeServer();
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("explicit setTokenAuth(null) => GET passes WITHOUT ?session=", async () => {
    const s = makeServer();
    s.setTokenAuth(null);
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
  });

  it("non-null token + valid ?session= => passes", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health?session=secret`);
    expect(res.status).toBe(200);
  });

  it("non-null token + MISSING ?session= => 403", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(403);
  });

  it("non-null token + WRONG ?session= => 403", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health?session=nope`);
    expect(res.status).toBe(403);
  });

  it("non-null token + valid body.token (POST) => passes", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health`, {
      method: "POST",
      body: JSON.stringify({ token: "secret" }),
    });
    expect(res.status).toBe(200);
  });

  it("non-null token + POST WITHOUT body.token => 403", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health`, {
      method: "POST",
      body: JSON.stringify({ other: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("origin guard runs FIRST: hostile Origin + valid ?session= => still 403 (origin)", async () => {
    // A valid token does NOT rescue a hostile origin => proves the origin guard
    // is checked before the token block. Body "forbidden" (lowercase) = origin.
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health?session=secret`, {
      headers: { Origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden");
  });

  it("token-block 403 body is 'Forbidden' (distinct from the origin 'forbidden')", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  it("v2: x-webui-token HEADER passes (preferred over ?session= — no query-string leak)", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health`, {
      headers: { "x-webui-token": "secret" },
    });
    expect(res.status).toBe(200);
  });

  it("v2: wrong x-webui-token HEADER => 403 (even with a valid ?session=)", async () => {
    // Header precedence: a presented header is authoritative — a wrong header
    // must not be rescued by a valid legacy query token.
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health?session=secret`, {
      headers: { "x-webui-token": "nope" },
    });
    expect(res.status).toBe(403);
  });

  it("v2: constant-time compare — wrong-length token => 403, no throw", async () => {
    const s = makeServer();
    s.setTokenAuth("a-very-long-secret-token");
    s.start();
    const res = await fetch(`${s.url}/health`, {
      headers: { "x-webui-token": "short" },
    });
    expect(res.status).toBe(403);
  });

  it("v2: WS upgrade ?session= path still works with the token set", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/ws?session=secret`, {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    // 400 (upgrade failed, no valid WS handshake headers) proves the token
    // check PASSED — a token failure would be 403.
    expect(res.status).toBe(400);
  });
});
