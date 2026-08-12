/**
 * web-server.test.ts — RED tests for the Broadcaster port + WebServer adapter
 * (Task 2). Per specs/04 §2/§3/§5/§6 + task-2-brief.md.
 *
 * The Broadcaster port (MemoryBroadcaster) tests are folded into this file so the
 * Task 2 commit stays at exactly three files (broadcaster.ts + web-server.ts +
 * this file). The WebServer adapter is the volatile transport; these tests cover:
 *  - origin guard (HTTP + WS handshake, shared) — specs/04 §5, §6
 *  - stub connect-test page + /health — specs/04 §5
 *  - singleton lifecycle (idempotent start, bind/drop session, port/url, .unref,
 *    stop tears the socket down) — specs/04 §3
 *  - serveWithFallback port-walk + exhaustion (EADDRINUSE x51) — specs/04 §2, §6
 *  - broadcast over a real WS (delivery, pruning, fire-and-forget) — specs/04 §3
 *  - the onCommand inbound seam + malformed-frame handling — specs/04 §6
 *
 * All servers bind port 0 (OS-assigned ephemeral) so tests never collide; every
 * started server is force-stopped in afterEach for tidy teardown. Real-WS tests
 * use a withTimeout guard so a racy case can never hang the runner.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { MemoryBroadcaster } from "../src/broadcaster.js";
import { WebServer } from "../src/web-server.js";
import type { ClientFrame, WebFrame } from "../src/protocol.js";

// --- test harness -----------------------------------------------------------

/** Every server we start, so afterEach can force-clean them. Servers are
 *  .unref()'d (so they won't hang the runner), but explicit teardown is tidy. */
const started: WebServer[] = [];
function makeServer(opts?: { port?: number; hostname?: string }): WebServer {
  const s = new WebServer(opts);
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

/** Race a promise against a timeout so a racy WS test can never hang. */
function withTimeout<T>(p: Promise<T>, ms = 2000, label = "timed out"): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

/** Wait until predicate() is true (polls), with a hard timeout. */
async function waitFor(name: string, predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor(${name}) timed out after ${ms}ms`);
}

/** Open a real WS to the server's /ws and resolve on open. Bun's WS client
 *  accepts a 2nd `headers` option (the WHATWG signature is extended at runtime). */
function openWs(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  const opts = headers ? ({ headers } as unknown as undefined) : undefined;
  const ws = headers ? new WebSocket(url, { headers } as never) : new WebSocket(url);
  void opts;
  return new Promise<WebSocket>((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws open failed"));
  });
}

// --- Broadcaster port (MemoryBroadcaster) -----------------------------------

describe("MemoryBroadcaster", () => {
  it("captures broadcast frames in order", () => {
    const b = new MemoryBroadcaster();
    b.broadcast({ type: "turn_start" });
    b.broadcast({ type: "agent_settled" });
    expect(b.frames.map((f) => f.type)).toEqual(["turn_start", "agent_settled"]);
  });

  it("mutex frames are captured with payload", () => {
    const b = new MemoryBroadcaster();
    const frame: WebFrame = { type: "mutex_blocked", blocked: "web", by: "tui" };
    b.broadcast(frame);
    expect(b.frames[0]).toEqual(frame);
  });
});

// --- WebServer origin guard (shared HTTP + WS) ------------------------------

describe("WebServer origin guard", () => {
  it("HTTP: non-loopback Origin -> 403", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const res = await fetch(`${s.url}/health`, { headers: { Origin: "http://evil.com" } });
    expect(res.status).toBe(403);
  });

  it("HTTP: absent Origin -> allowed (200 'ok')", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("WS handshake: non-loopback Origin -> upgrade denied (403, not 101)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const res = await fetch(`${s.url}/ws`, {
      headers: {
        Origin: "http://evil.com",
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    expect(res.status).toBe(403);
  });

  it("WS client: non-loopback Origin -> upgrade refused (connection never opens)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    let opened = false;
    let settled = false;
    const ws = new WebSocket(
      `${s.url.replace("http", "ws")}/ws`,
      { headers: { Origin: "http://evil.com" } } as never
    );
    ws.onopen = () => {
      opened = true;
      settled = true;
    };
    ws.onerror = () => {
      settled = true;
    };
    ws.onclose = () => {
      settled = true;
    };
    await withTimeout(
      (async () => {
        while (!settled) await Bun.sleep(5);
      })(),
      2000,
      "ws denial never settled"
    );
    expect(opened).toBe(false);
  });

  it("origin guard is shared on HTTP + WS (both 403 for the same bad origin)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const http = await fetch(`${s.url}/`, { headers: { Origin: "http://evil.com" } });
    const ws = await fetch(`${s.url}/ws`, {
      headers: { Origin: "http://evil.com", Upgrade: "websocket" },
    });
    expect(http.status).toBe(403);
    expect(ws.status).toBe(403);
  });
});

// --- WebServer stub page + health ------------------------------------------

describe("WebServer stub page + health", () => {
  it("GET /health -> 200 'ok'", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET / -> 200 HTML connect-test page that opens the WS", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const res = await fetch(`${s.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // A real frontend is ticket 06; this stub only needs to open the WS.
    expect(body).toContain("/ws");
    expect(body).toContain("WebSocket");
  });
});

// --- WebServer singleton lifecycle -----------------------------------------

describe("WebServer singleton lifecycle", () => {
  it("start is idempotent (second start is a no-op, same url + port)", () => {
    const s = makeServer({ port: 0 });
    s.start();
    const url1 = s.url;
    const port1 = s.port;
    s.start(); // no-op
    expect(s.url).toBe(url1);
    expect(s.port).toBe(port1);
  });

  it("bindSession / dropSession swap the live session ref without restarting", () => {
    const s = makeServer({ port: 0 });
    s.start();
    const url1 = s.url;
    expect(s.hasSession()).toBe(false);
    s.bindSession(
      { sendUserMessage: () => {} } as never,
      { abort: () => {} } as never
    );
    expect(s.hasSession()).toBe(true);
    s.bindSession(
      { sendUserMessage: () => {} } as never,
      { abort: () => {} } as never
    ); // re-point
    expect(s.hasSession()).toBe(true);
    s.dropSession(); // server stays
    expect(s.hasSession()).toBe(false);
    expect(s.url).toBe(url1); // not restarted
  });

  it("the bound port + url are readable after start", () => {
    const s = makeServer({ port: 0 });
    s.start();
    expect(typeof s.port).toBe("number");
    expect(s.port).toBeGreaterThan(0);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
  });

  it("unrefs the server so it does not keep the process alive (unrefed === true)", () => {
    const s = makeServer({ port: 0 });
    s.start();
    expect(s.unrefed).toBe(true);
  });

  it("stop tears the socket down (the URL stops serving)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const url = s.url;
    // sanity: serving before stop
    const before = await fetch(`${url}/health`);
    expect(before.status).toBe(200);
    s.stop();
    // after stop, the socket refuses new connections (poll — OS release is async)
    let refused = false;
    for (let i = 0; i < 30; i++) {
      try {
        await fetch(`${url}/health`);
        await Bun.sleep(20);
      } catch {
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
  });
});

// --- WebServer serveWithFallback (inline copy, port-walk) ------------------

describe("WebServer serveWithFallback", () => {
  it("walks past a busy port to the next free one within port..port+50", () => {
    // Random high base unlikely to collide; occupy it with a raw server.
    const base = 25000 + Math.floor(Math.random() * 15000);
    let occupier: ReturnType<typeof Bun.serve> | null = null;
    try {
      try {
        occupier = Bun.serve({
          port: base,
          hostname: "127.0.0.1",
          fetch: () => new Response("x"),
        });
      } catch {
        // base was busy in this env — skip the walk assertion rather than flake.
        return;
      }
      const s = makeServer({ port: base });
      s.start();
      const bound = s.port;
      expect(bound).not.toBe(base);
      expect(bound - base).toBeGreaterThan(0);
      expect(bound - base).toBeLessThanOrEqual(50);
    } finally {
      try {
        occupier?.stop(true);
      } catch {
        /* ignore */
      }
    }
  });

  it("throws when the entire port..port+50 range is busy (EADDRINUSE x51)", () => {
    // Occupy a full 51-port block (base..base+50) so serveWithFallback cannot
    // bind any. Retry on a fresh random base if the env happens to hold one.
    let okBase = -1;
    const occupiers: Array<ReturnType<typeof Bun.serve>> = [];
    try {
      for (let attempt = 0; attempt < 6 && okBase < 0; attempt++) {
        const tryBase = 25000 + Math.floor(Math.random() * 15000);
        const trial: Array<ReturnType<typeof Bun.serve>> = [];
        try {
          for (let p = tryBase; p < tryBase + 51; p++) {
            trial.push(
              Bun.serve({
                port: p,
                hostname: "127.0.0.1",
                fetch: () => new Response("x"),
              })
            );
          }
          okBase = tryBase;
          for (const sv of trial) occupiers.push(sv);
        } catch {
          for (const sv of trial) {
            try {
              sv.stop(true);
            } catch {
              /* ignore */
            }
          }
        }
      }
      if (okBase < 0) {
        // Env too crowded to hold 51 consecutive ports — skip, don't flake.
        return;
      }
      const s = makeServer({ port: okBase });
      expect(() => s.start()).toThrow();
    } finally {
      for (const sv of occupiers) {
        try {
          sv.stop(true);
        } catch {
          /* ignore */
        }
      }
    }
  });
});

// --- WebServer broadcast over a real WS ------------------------------------

describe("WebServer broadcast over a real WS", () => {
  it("delivers a broadcast frame to a connected client (exact JSON)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const ws = await withTimeout(
      openWs(`${s.url.replace("http", "ws")}/ws`),
      2000,
      "ws open timed out"
    );
    // Wait until the server has registered the client (removes any race).
    await waitFor("client registered", () => s.clientCount === 1);

    const received = new Promise<string>((resolve) => {
      ws.onmessage = (ev) => resolve(String(ev.data));
    });
    s.broadcast({ type: "turn_start" });
    const data = await withTimeout(received, 2000, "frame not delivered");
    // Exact JSON frame, no pretty-printing.
    expect(data).toBe(JSON.stringify({ type: "turn_start" }));
    expect(JSON.parse(data)).toEqual({ type: "turn_start" });
    ws.close();
  });

  it("delivers to multiple connected clients", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const ws1 = await withTimeout(openWs(`${s.url.replace("http", "ws")}/ws`), 2000, "ws1 open");
    const ws2 = await withTimeout(openWs(`${s.url.replace("http", "ws")}/ws`), 2000, "ws2 open");
    await waitFor("two clients registered", () => s.clientCount === 2);

    const r1 = new Promise<string>((r) => (ws1.onmessage = (e) => r(String(e.data))));
    const r2 = new Promise<string>((r) => (ws2.onmessage = (e) => r(String(e.data))));
    s.broadcast({ type: "agent_settled" });
    const [d1, d2] = await Promise.all([
      withTimeout(r1, 2000, "ws1 frame"),
      withTimeout(r2, 2000, "ws2 frame"),
    ]);
    expect(d1).toBe(JSON.stringify({ type: "agent_settled" }));
    expect(d2).toBe(JSON.stringify({ type: "agent_settled" }));
    ws1.close();
    ws2.close();
  });

  it("prunes a client after it disconnects", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const ws = await withTimeout(openWs(`${s.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => s.clientCount === 1);
    ws.close();
    await waitFor("client pruned", () => s.clientCount === 0);
  });

  it("broadcast is fire-and-forget: never throws on a dead socket", () => {
    const s = makeServer({ port: 0 });
    s.start();
    // Inject a broken (dead) client whose .send throws — broadcast must swallow.
    (
      s as unknown as { clients: Set<{ send(): void }> }
    ).clients.add({
      send() {
        throw new Error("dead socket");
      },
    });
    expect(() => s.broadcast({ type: "turn_start" })).not.toThrow();
  });

  it("broadcast to zero clients is a harmless no-op (no throw)", () => {
    const s = makeServer({ port: 0 });
    s.start();
    expect(() => s.broadcast({ type: "agent_settled" })).not.toThrow();
  });
});

// --- WebServer inbound seam (onCommand) + malformed handling ----------------

describe("WebServer inbound seam", () => {
  it("hands a validated inbound command to the onCommand seam, and replies", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const seen: ClientFrame[] = [];
    s.setCommandHandler((frame, reply) => {
      seen.push(frame);
      reply({ type: "turn_start" });
    });
    const ws = await withTimeout(openWs(`${s.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => s.clientCount === 1);

    const got = new Promise<WebFrame>((resolve) => {
      ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)) as WebFrame);
    });
    ws.send(JSON.stringify({ type: "prompt", text: "hi" }));
    const reply = await withTimeout(got, 2000, "reply not delivered");
    expect(reply).toEqual({ type: "turn_start" });
    expect(seen).toEqual([{ type: "prompt", text: "hi" }]);
    ws.close();
  });

  it("ignores malformed inbound frames (never calls onCommand, never throws)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    let called = false;
    s.setCommandHandler(() => {
      called = true;
    });
    const ws = await withTimeout(openWs(`${s.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => s.clientCount === 1);
    ws.send("not json at all"); // malformed JSON
    ws.send(JSON.stringify({ type: "nope" })); // schema-invalid
    await Bun.sleep(50); // let the server process both
    expect(called).toBe(false);
    ws.close();
  });

  it("without a command handler set, inbound commands are silently dropped", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const ws = await withTimeout(openWs(`${s.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => s.clientCount === 1);
    expect(() => ws.send(JSON.stringify({ type: "abort" }))).not.toThrow();
    await Bun.sleep(50);
    ws.close();
  });
});

// --- WebServer setHttpRoutes (ticket 06 additive route seam) ---------------

describe("WebServer setHttpRoutes", () => {
  it("a registered handler answers its path", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setHttpRoutes((req) => {
      if (new URL(req.url).pathname === "/x") return new Response("from-route");
      return null;
    });
    const res = await fetch(`${s.url}/x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-route");
  });

  it("a null return falls through to the existing /health route", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setHttpRoutes(() => null);
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("with no handler set, existing routes are unchanged", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
  });

  it("routes are still origin-guarded (non-loopback Origin -> 403)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setHttpRoutes(() => new Response("x"));
    const res = await fetch(`${s.url}/anything`, { headers: { Origin: "http://evil.com" } });
    expect(res.status).toBe(403);
  });

  it("setHttpRoutes(null) removes a previously-registered handler", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setHttpRoutes(() => new Response("custom", { status: 418 }));
    s.setHttpRoutes(null);
    const res = await fetch(`${s.url}/anything`);
    expect(res.status).toBe(404); // falls back to the default not-found branch
  });
});
