/**
 * wiring-live-smoke.test.ts — HAND-OFF SMOKE TEST for the merged "ticket 04 —
 * webui web transport" feature.
 *
 * GOAL: prove the LIVE webui transport works end-to-end against the REAL
 * `wireWebui` composition root. This is NOT a re-implementation — it drives the
 * production wiring path against a minimal-but-real `pi` host stub, with a REAL
 * `Bun.serve` (the wiring's WebServer) and REAL WebSocket clients. The only
 * thing mocked is the narrow `WebuiHost` surface (`on` + render seams); the
 * stub's `sendUserMessage` is now a RECORDER — de-chat (event-cards 00) proof
 * that the wiring never injects prompts into the session.
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
 * the only stub is the `on`/render-seam host surface.
 *
 * Helper parity: withTimeout / waitFor / openWs are lifted verbatim from
 * web-server.test.ts so this file shares its proven harness shape.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import {
  wireWebui,
  type WebuiHost,
  type WebuiWiring,
  type RenderHostEvents,
  type WebuiUi,
} from "../src/webui-wiring.js";
import { resolvePort } from "../src/port-resolver.js";

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

/**
 * Resolve on the next WS message that is NOT the connect-time snapshot frame
 * (v2, architecture v2 §3.3): the wiring now pushes `{type:"snapshot",…}` to
 * every client on open, so tests that assert on the FIRST live frame must skip
 * it. Snapshot frames are filtered; the first non-snapshot frame resolves.
 */
function nextNonSnapshot(ws: WebSocket): Promise<string> {
  return new Promise<string>((resolve) => {
    const handler = (ev: MessageEvent) => {
      const text = String(ev.data);
      try {
        if (JSON.parse(text).type === "snapshot") return; // skip
      } catch {
        /* malformed — treat as a real frame */
      }
      ws.removeEventListener("message", handler);
      resolve(text);
    };
    ws.addEventListener("message", handler);
  });
}

/** True iff a frame (non-snapshot) has arrived on `ws`. */
function hasLiveFrame(ws: WebSocket): { got: () => boolean } {
  let got = false;
  ws.addEventListener("message", (ev) => {
    try {
      if (JSON.parse(String(ev.data)).type === "snapshot") return;
    } catch {
      /* fall through */
    }
    got = true;
  });
  return { got: () => got };
}

// --- the minimal-but-real pi host stub --------------------------------------

/**
 * Minimal `WebuiHost` implementation. Records every `on` registration so tests
 * can REPLAY pi events into the wiring's real handlers (the exact thing a real
 * ExtensionAPI does — fire the event, the handler runs). Records sendUserMessage
 * + abort calls for assertions (de-chat: `sendUserMessage` is an EXTRA member —
 * the narrowed WebuiHost no longer declares it; the recorder stays as negative
 * proof that the wiring never injects prompts).
 */
class MockPi implements WebuiHost {
  readonly handlers = new Map<string, (event: any, ctx: any) => any>();
  readonly sent: Array<{ content: string | unknown[]; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  readonly registeredTools: unknown[] = [];
  readonly events: RenderHostEvents;
  aborts = 0;
  // ticket 07 announce recording (populated by ctx(); fresh per session_start):
  uiNotifications: Array<{ message: string; type?: string }> = [];
  uiStatuses: Array<{ key: string; text: string | undefined }> = [];
  // ticket 07 no-auto-open negative control (the host interface exposes no
  // exec; this recorder asserts the wiring never reaches for one):
  execCalls = 0;

  constructor() {
    const channels = new Map<string, Set<(data: unknown) => void>>();
    this.events = {
      on(channel, handler) {
        let set = channels.get(channel);
        if (!set) { set = new Set(); channels.set(channel, set); }
        set.add(handler);
        return () => { set!.delete(handler); };
      },
      emit(channel, data) {
        channels.get(channel)?.forEach((h) => h(data));
      },
    };
  }

  on(event: string, handler: (event: any, ctx: any) => any): void {
    this.handlers.set(event, handler);
  }

  sendUserMessage(
    content: string | unknown[],
    opts?: { deliverAs?: "steer" | "followUp" }
  ): void {
    this.sent.push({ content, opts });
  }

  registerTool(tool: unknown): void {
    this.registeredTools.push(tool);
  }

  /** Replay a pi host event into the wiring's real registered handler. */
  emit(event: string, payload: any = {}, ctx: any = undefined): any {
    const h = this.handlers.get(event);
    return h ? h(payload, ctx) : undefined;
  }

  /** A fake session ctx whose abort() is observable. */
  ctx(): { abort(): void; ui: WebuiUi } {
    const self = this;
    // fresh recording arrays per ctx() (each session_start gets a clean slate);
    // exposed on the instance for assertions.
    self.uiNotifications = [];
    self.uiStatuses = [];
    return {
      abort() {
        self.aborts++;
      },
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          self.uiNotifications.push({ message, type });
        },
        setStatus: (key: string, text: string | undefined) => {
          self.uiStatuses.push({ key, text });
        },
      },
    };
  }

  /** Records exec calls (ticket 07 no-auto-open negative control). NOT on
   *  WebuiHost — the wiring cannot call it through the typed host. */
  async exec(_command: string, _args: string[]): Promise<{ code: number; stderr: string }> {
    this.execCalls++;
    return { code: 0, stderr: "" };
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
  it("A) after session_start, GET / serves the render shell (ticket 06)", async () => {
    const { pi, server, wiring } = setup();
    pi.emit("session_start", {}, pi.ctx());
    wiring; // referenced for clarity
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("webui-render-shell");
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

  it("C) webui-v3 02 diet: log events never reach the WS client", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    // webui-v3 (02) diet: log events (turn_start) are TUI-only — NOTHING may
    // reach the WS client. Collect every frame after connect for a beat.
    const live: string[] = [];
    ws.onmessage = (ev: { data: unknown }) => live.push(String(ev.data));
    pi.emit("turn_start", { type: "turn_start" });
    await Bun.sleep(250); // give a would-be forward time to (never) fire
    const liveTypes = live.map((s) => { try { return JSON.parse(s).type; } catch { return "?"; } });
    expect(liveTypes.filter((ty) => ty !== "snapshot")).toEqual([]); // snapshot may race in; NO live frames
  });

  it("C2) a client connecting mid-session receives the v2 snapshot FIRST (bounded transcript replay)", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // webui-v3 (02) diet: history = kept-family frames only — web acquires
    // the lock, a blocked TUI input broadcasts mutex_blocked.
    pi.emit("input", { type: "input", source: "extension" });
    pi.emit("input", { type: "input", source: "interactive" });

    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    const first = new Promise<string>((resolve) => {
      ws.onmessage = (ev) => resolve(String(ev.data));
    });
    const raw = await withTimeout(first, 2000, "snapshot frame not delivered");
    const frame = JSON.parse(raw);
    expect(frame.type).toBe("snapshot");
    expect(frame.state.transcript.map((f: { type: string }) => f.type)).toEqual([
      "session_info",
      "mutex_blocked",
    ]);
    expect(frame.state.presentId).toBeNull();
    expect(frame.state.driver).toBe("web"); // blocked-TUI fixture: web legitimately holds the lock
  });

  it("D) inbound prompt frame is deliberately IGNORED (de-chat): pi.sendUserMessage never called", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    // DE-CHAT (event-cards 00): the main composer is gone — the wiring no
    // longer routes prompt frames to pi.sendUserMessage. The frame still
    // validates (protocol) + parses (transport), but the wiring's dispatch
    // seam is a deliberate no-op for agentic frames.
    ws.send(JSON.stringify({ type: "prompt", text: "smoke hello" }));
    await Bun.sleep(150); // give the (absent) dispatch time to never fire
    expect(pi.sent).toEqual([]); // sendUserMessage never called
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

  it("G) first render announces the resolved URL via ctx.ui (not at session_start), no auto-open", async () => {
    const { pi, server } = setup();
    // NOTE: the inline MockPi resets uiNotifications/uiStatuses FRESH per
    // pi.ctx() call, so call ctx() exactly ONCE (at session_start) — the
    // fire-once listener reads bound.ctx.ui, which is that same ctx.
    pi.emit("session_start", {}, pi.ctx());
    // session_start alone: NO announce (deferred to first render).
    expect(pi.uiNotifications).toEqual([]);
    expect(pi.uiStatuses).toEqual([]);
    // first render triggers the announce. pi.events.emit flows through the
    // wiring's registered webui:render handler into registry.render(), which
    // fires the fire-once announce listener.
    pi.events.emit("webui:render", { content: "# first" });
    expect(pi.uiNotifications).toEqual([
      { message: `webui ready — open ${server.url} in a browser to view rendered results and send feedback. (loopback · no auth)`, type: "info" },
    ]);
    expect(pi.uiStatuses).toEqual([{ key: "webui", text: `🌐 webui · ${server.url} · open in browser to view results` }]);
    // one-shot: a second render must NOT re-announce.
    pi.events.emit("webui:render", { content: "# second" });
    expect(pi.uiNotifications).toHaveLength(1);
    // No auto-open: the wiring never calls pi.exec (the host interface exposes
    // no exec). The exec recorder is a belt-and-suspenders negative control.
    expect(pi.execCalls).toBe(0);
  });

  it("H) announce-on-first-render + port resolution compose: announced URL is the live loopback URL", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // not at session_start — deferred to first render.
    expect(pi.uiNotifications).toEqual([]);
    pi.events.emit("webui:render", { content: "# x" });
    // The announced URL is embedded in the v2-enriched banner/footer; assert
    // the live resolved loopback URL is present (listener reads server.url).
    expect(pi.uiNotifications[0]?.message).toContain(server.url);
    expect(pi.uiStatuses[0]?.text).toContain(server.url);
    // server.url is the LIVE resolved URL — a real loopback address with a real
    // (non-zero) port produced by resolvePort via getServer() (T2). Not literal 0.
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);
    expect(new URL(server.url).port).not.toBe("0");
  });

  it("I) v1 wires null token => /, /api/views, /api/events all pass WITHOUT ?session=", async () => {
    // wireWebui calls server.setTokenAuth(null) (T4). With the token null the
    // fetch token block is skipped, so NO request needs ?session=. Proves the
    // loopback wiring is "off" end-to-end against a live server.
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const root = await fetch(`${server.url}/`);
    expect(root.status).toBe(200);
    const views = await fetch(`${server.url}/api/views`);
    expect(views.status).toBe(200);
    const ctrl = new AbortController();
    const events = await fetch(`${server.url}/api/events`, { signal: ctrl.signal });
    // /api/events is an SSE stream — the origin guard + null-token skip let it
    // through (200); we only assert it is reachable (not 403/404).
    expect(events.status).toBe(200);
    // The stream is long-lived — abort it so it cannot dangle (matches the
    // other SSE tests, e.g. render-routes.test.ts view_update/heartbeat).
    ctrl.abort();
  });

  it("J) v1 wires null token => /ws upgrade succeeds WITHOUT ?session=", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(
      openWs(`${server.url.replace("http", "ws")}/ws`),
      2000,
      "ws open timed out"
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("K) resolvePort 3-tier is honored (WEBUI_PORT > PORT > 0) — pure, integration-recorded", () => {
    // The pure resolver is unit-tested in port-resolver.test.ts (T2); this case
    // records the ordering in the live integration suite. resolvePort is the
    // function getServer() calls (T2 wiring).
    expect(resolvePort({ WEBUI_PORT: "8080", PORT: "9000" })).toBe(8080);
    expect(resolvePort({ PORT: "9000" })).toBe(9000);
    expect(resolvePort({})).toBe(0);
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

    // Skip the connect-time snapshot frame (v2) — resolve on the first LIVE frame.
    const received = nextNonSnapshot(ws);

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

    // gotFrame counts LIVE frames only — the connect-time snapshot (v2) is
    // expected and must not trip the negative control.
    const live = hasLiveFrame(ws);
    // No prior acquisition — tui input is the FIRST gate call -> "continue".
    pi.emit("input", { source: "interactive" });
    await Bun.sleep(80); // give the (absent) broadcast time to never arrive
    expect(live.got()).toBe(false);
  });
});
