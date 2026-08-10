/**
 * wiring-live-smoke.test.ts — HAND-OFF SMOKE TEST for the merged "ticket 04 —
 * webui web transport" feature.
 *
 * GOAL: prove the LIVE webui transport works end-to-end against the REAL
 * `wireWebui` composition root. This is NOT a re-implementation — it drives the
 * production wiring path against a minimal-but-real `pi` host stub, with a REAL
 * `Bun.serve` (the wiring's WebServer) and REAL WebSocket clients. The only
 * thing mocked is the narrow `WebuiHost` surface (`on` + `sendUserMessage`),
 * which is exactly the interface the wiring declares as its dependency.
 *
 * PORT DISCOVERY SEAM (the KEY QUESTION):
 *   `wireWebui(pi, deps)` accepts `deps.server: WebuiServer` (documented in
 *   webui-wiring.ts: "Testability: `deps` lets a test inject..."). We inject a
 *   REAL `new WebServer({ port: 0 })` — a real Bun.serve on an OS-assigned
 *   ephemeral loopback port. After `session_start`, the wiring calls
 *   `server.start()` (lazy bind) and we read `server.port`. This is option (c)
 *   "construct your own WebServer instance and drive wiring through it" — chosen
 *   because it is the wiring's OWN documented injection seam, drives the REAL
 *   wireWebui (not a fake), AND sidesteps the module-level singleton entirely
 *   (getServer() is never reached when `deps.server` is provided → ZERO singleton
 *   leakage between tests).
 *
 * SINGLETON-HYGIENE NOTE: by ALWAYS injecting `deps.server`, this suite never
 * touches the module-level `singletonServer` in webui-wiring.ts. Each test gets
 * a fresh WebServer + fresh MockPi + fresh wiring; `dispose()` (and afterEach)
 * tear them down. No global state is mutated or restored.
 *
 * MUTEX (Tier B / F): driven through the wiring's REAL `pi.on("input")`
 * registration — we replay `{source:"extension"}` (web acquires the lock) then
 * `{source:"interactive"}` (tui blocked) by invoking the handler the wiring
 * registered. This exercises the REAL MutexController + REAL BroadcastingNotifier
 * + REAL WebServer broadcaster → REAL WS delivery. NOT a mock of the controller;
 * the only stub is the `on`/`sendUserMessage` host surface.
 *
 * Helper parity: withTimeout / waitFor / openWs are lifted verbatim from
 * web-server.test.ts so this file shares its proven harness shape.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { wireWebui, type WebuiHost, type WebuiWiring } from "../src/webui-wiring.js";

// --- test harness (copied shape from web-server.test.ts) --------------------

/** Every server we start, so afterEach force-cleans them. Servers are .unref()'d
 *  (so they won't hang the runner), but explicit teardown is tidy. */
const started: WebServer[] = [];
function makeServer(opts?: { port?: number; hostname?: string }): WebServer {
  const s = new WebServer(opts);
  started.push(s);
  return s;
}

/** Wirings + clients we created, torn down in afterEach for isolation. */
const wirings: WebuiWiring[] = [];
const openClients: WebSocket[] = [];

afterEach(() => {
  // Neutralize every wiring (sets disposed=true, stops its injected server,
  // drops the session). Idempotent.
  while (wirings.length) {
    try {
      wirings.pop()!.dispose();
    } catch {
      /* ignore */
    }
  }
  // Close any stray WS clients.
  for (const ws of openClients) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  openClients.length = 0;
  // Force-stop every server we made (defensive — dispose() already stops the
  // injected ones, but makeServer-tracked servers are independent guarantees).
  while (started.length) {
    try {
      started.pop()!.stop();
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
 *  accepts a 2nd `headers` option. */
function openWs(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  const ws = headers ? new WebSocket(url, { headers } as never) : new WebSocket(url);
  openClients.push(ws);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws open failed"));
  });
}

// --- the minimal-but-real pi host stub --------------------------------------

/**
 * Minimal `WebuiHost` implementation. Records every `on` registration so tests
 * can REPLAY pi events into the wiring's real handlers (the exact thing a real
 * ExtensionAPI does — fire the event, the handler runs). Records sendUserMessage
 * + abort calls for assertions.
 */
class MockPi implements WebuiHost {
  readonly handlers = new Map<string, (event: any, ctx: any) => any>();
  readonly sent: Array<{ content: string | unknown[]; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  aborts = 0;

  on(event: string, handler: (event: any, ctx: any) => any): void {
    this.handlers.set(event, handler);
  }

  sendUserMessage(
    content: string | unknown[],
    opts?: { deliverAs?: "steer" | "followUp" }
  ): void {
    this.sent.push({ content, opts });
  }

  /** Replay a pi host event into the wiring's real registered handler. */
  emit(event: string, payload: any = {}, ctx: any = undefined): any {
    const h = this.handlers.get(event);
    return h ? h(payload, ctx) : undefined;
  }

  /** A fake session ctx whose abort() is observable. */
  ctx(): { abort(): void } {
    const self = this;
    return {
      abort() {
        self.aborts++;
      },
    };
  }
}

/** Wire up a fresh real wiring bound to a fresh real WebServer (ephemeral port). */
function setup(): { pi: MockPi; server: WebServer; wiring: WebuiWiring } {
  const pi = new MockPi();
  const server = makeServer({ port: 0 });
  // Inject the REAL server → wiring uses it instead of the module singleton.
  const wiring = wireWebui(pi, { server });
  wirings.push(wiring);
  return { pi, server, wiring };
}

// ===========================================================================
// Tier A — MUST pass
// ===========================================================================

describe("wireWebui live smoke — Tier A", () => {
  it("A) after session_start, GET / serves the stub HTML page (webui connect-test)", async () => {
    const { pi, server, wiring } = setup();
    // session_start: wiring lazily starts the server + binds the session.
    pi.emit("session_start", {}, pi.ctx());
    wiring; // referenced for clarity
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("webui connect-test");
    // And the page wires up /ws (the real frontend is ticket 06).
    expect(body).toContain("/ws");
  });

  it("B) client connects to ws://127.0.0.1:<port>/ws + sends {type:subscribe} -> server.clientCount === 1", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(
      openWs(`${server.url.replace("http", "ws")}/ws`),
      2000,
      "ws open timed out"
    );
    // subscribe is a v1 control no-op (WS open already tracks the client), but
    // sending it proves the inbound path is live without erroring.
    ws.send(JSON.stringify({ type: "subscribe" }));
    await waitFor("client registered", () => server.clientCount === 1);
    expect(server.clientCount).toBe(1);
  });

  it("C) frame forwarding: a forwarded pi event reaches the WS client as the exact WebFrame", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    const received = new Promise<string>((resolve) => {
      ws.onmessage = (ev) => resolve(String(ev.data));
    });
    // Replay an outbound event the wiring forwards verbatim (turn_start ∈
    // OUTBOUND_EVENTS). transport.mapEvent forwards .type intact.
    pi.emit("turn_start", { type: "turn_start" });
    const data = await withTimeout(received, 2000, "forwarded frame not delivered");
    expect(data).toBe(JSON.stringify({ type: "turn_start" }));
    expect(JSON.parse(data)).toEqual({ type: "turn_start" });
  });

  it("D) inbound prompt dispatch: {type:prompt,text:'smoke hello'} -> pi.sendUserMessage('smoke hello')", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    ws.send(JSON.stringify({ type: "prompt", text: "smoke hello" }));
    // The wiring's onCommand seam dispatches synchronously after the server's
    // message handler runs; poll for the recorded call.
    await waitFor("sendUserMessage recorded", () => pi.sent.length === 1);
    expect(pi.sent).toEqual([
      { content: "smoke hello", opts: undefined },
    ]);
  });

  it("E) origin guard: a non-loopback Origin is rejected (HTTP 403)", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // Shared origin guard on HTTP fetch (web-server.ts originAllowed): a
    // present non-loopback Origin must be denied.
    const res = await fetch(`${server.url}/`, { headers: { Origin: "http://evil.com" } });
    expect(res.status).toBe(403);
  });

  it("E2) origin guard: WS handshake with non-loopback Origin is refused (client never opens)", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    let opened = false;
    let settled = false;
    const ws = new WebSocket(
      `${server.url.replace("http", "ws")}/ws`,
      { headers: { Origin: "http://evil.com" } } as never
    );
    openClients.push(ws);
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
});

// ===========================================================================
// Tier B — best effort
// ===========================================================================

describe("wireWebui live smoke — Tier B", () => {
  it("F) mutex interplay: web holds the lock -> tui 'input' blocked -> client receives {mutex_blocked,blocked:tui,by:web}", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    const received = new Promise<string>((resolve) => {
      ws.onmessage = (ev) => resolve(String(ev.data));
    });

    // (1) Acquire the mutex lock as the WEB frontend. The wiring's input handler
    //     is `controller.handleInput(event.source)`. "extension" -> toFrontend
    //     -> "web"; driver was null, so it is acquired (verdict "continue").
    pi.emit("input", { source: "extension" });

    // (2) Now a TUI input arrives ("interactive" -> "tui") while "web" holds the
    //     lock -> verdict "handled" -> BroadcastingNotifier broadcasts
    //     {type:"mutex_blocked",blocked:"tui",by:"web"} through the real
    //     WebServer broadcaster -> the connected WS client receives it.
    pi.emit("input", { source: "interactive" });

    const data = await withTimeout(received, 2000, "mutex_blocked frame not delivered");
    expect(JSON.parse(data)).toEqual({ type: "mutex_blocked", blocked: "tui", by: "web" });
  });

  it("F2) confirm the NO-block path does NOT emit a mutex frame (negative control for F)", async () => {
    // Without a lock held, a tui input is allowed (verdict "continue") and NO
    // mutex_blocked frame is broadcast. This proves F's assertion is causal on
    // the block, not tautological on "any input emits a frame".
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    let gotFrame = false;
    ws.onmessage = () => {
      gotFrame = true;
    };
    // No prior acquisition — tui input is the FIRST gate call -> "continue".
    pi.emit("input", { source: "interactive" });
    await Bun.sleep(80); // give the (absent) broadcast time to never arrive
    expect(gotFrame).toBe(false);
  });
});
