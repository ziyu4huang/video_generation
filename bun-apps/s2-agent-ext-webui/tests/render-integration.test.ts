/**
 * render-integration.test.ts — end-to-end for the generic render framework
 * (ticket 06), driving the REAL wireWebui composition root against a minimal
 * MockPi host + a REAL WebServer. Mirrors wiring-live-smoke.test.ts's harness
 * (withTimeout / waitFor / openWs / MockPi), extended with the render seams
 * (events + registerTool) the widened WebuiHost now requires.
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

// --- harness (copied + extended from wiring-live-smoke.test.ts) ------------

const started: WebServer[] = [];
function makeServer(): WebServer {
  const s = new WebServer({ port: 0 });
  started.push(s);
  return s;
}
const wirings: WebuiWiring[] = [];
const openClients: WebSocket[] = [];

afterEach(() => {
  while (wirings.length) {
    try { wirings.pop()!.dispose(); } catch { /* ignore */ }
  }
  for (const ws of openClients) { try { ws.close(); } catch { /* ignore */ } }
  openClients.length = 0;
  while (started.length) { try { started.pop()!.stop(); } catch { /* ignore */ } }
});

function withTimeout<T>(p: Promise<T>, ms = 2000, label = "timed out"): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}
async function waitFor(name: string, predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor(${name}) timed out after ${ms}ms`);
}
function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  openClients.push(ws);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws open failed"));
  });
}

/** Minimal-but-real WebuiHost. Adds the render seams (events + registerTool)
 *  the widened interface now requires. */
class MockPi implements WebuiHost {
  readonly handlers = new Map<string, (event: any, ctx: any) => any>();
  readonly sent: Array<{ content: string | unknown[]; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  readonly registeredTools: unknown[] = [];
  readonly events: RenderHostEvents;
  aborts = 0;

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
  sendUserMessage(content: string | unknown[], opts?: { deliverAs?: "steer" | "followUp" }): void {
    this.sent.push({ content, opts });
  }
  registerTool(tool: unknown): void {
    this.registeredTools.push(tool);
  }

  /** Replay a pi.on(...) handler (mirrors wiring-live-smoke). */
  emit(event: string, payload: any = {}, ctx: any = undefined): any {
    const h = this.handlers.get(event);
    return h ? h(payload, ctx) : undefined;
  }
  ctx(): { abort(): void; ui: WebuiUi } {
    const self = this;
    return {
      abort() {
        self.aborts++;
      },
      ui: {
        notify: (_message: string, _type?: "info" | "warning" | "error") => {
          /* announce recording not asserted in this suite; stub satisfies the
           * widened WebuiSessionCtx so session_start can reach ctx.ui. */
        },
        setStatus: (_key: string, _text: string | undefined) => {
          /* same */
        },
      },
    };
  }
}

function setup(): { pi: MockPi; server: WebServer; wiring: WebuiWiring } {
  const pi = new MockPi();
  const server = makeServer();
  const wiring = wireWebui(pi, { server });
  wirings.push(wiring);
  return { pi, server, wiring };
}

// ---------------------------------------------------------------------------

describe("wireWebui render framework — end-to-end", () => {
  it("registers the webui_present tool + webui:render subscription during wiring", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tools = pi.registeredTools as Array<{ name: string }>;
    expect(tools.some((t) => t.name === "webui_present")).toBe(true);
    // the event subscription routes into the registry: emit -> GET /api/view/:id
    pi.events.emit("webui:render", { content: "# hello", view: "preview", title: "P" });
    const res = await fetch(`${server.url}/api/view/preview`);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.mode).toBe("md");
    expect(v.html).toContain("<h1");
    expect(v.title).toBe("P");
  });

  it("GET / serves the render shell after wiring", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const body = await (await fetch(`${server.url}/`)).text();
    expect(body).toContain("webui-render-shell");
  });

  it("the loopback view URL (server.url/#id) is a live address (event-driven; webui_render is gone)", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    pi.events.emit("webui:render", { content: "x", view: "z" });
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(views).toMatchObject([{ id: "z" }]);
    // The URL form the framework composes is `${server.url}/#z`; the fragment
    // is client-side routing, so that address is a GET / -> the render shell.
    const body = await (await fetch(`${server.url}/#z`)).text();
    expect(body).toContain("webui-render-shell");
  });

  it("WS delivers a view_update frame on webui:render (webui-simplify §3: one live transport)", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    pi.events.emit("webui:render", { content: "# hi", view: "sse-view" });
    // The registry render fires view_update to subscribers; the wiring's
    // subscriber broadcasts it as a frame through the store-wrapped
    // broadcaster (live fan-out + connect-time replay both carry it).
    const raw = await withTimeout(
      (async () => {
        for (;;) {
          const msg = await new Promise<MessageEvent>((resolve) => {
            ws.addEventListener("message", resolve, { once: true });
          });
          try {
            const f = JSON.parse(String(msg.data));
            if (f.type === "view_update") return String(msg.data);
          } catch { /* skip non-JSON */ }
        }
      })(),
      2000,
      "view_update frame not delivered"
    );
    expect(JSON.parse(raw)).toMatchObject({ type: "view_update", viewId: "sse-view" });
    ws.close();
  });
});

describe("wireWebui render framework — de-chat: the send-queue machinery survives (event-cards 00)", () => {
  it("the SERVED shell still ships sendRaw + wsQueue + sendAppexecResponse (composer restored, queue kept)", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const body = await (await fetch(`${server.url}/`)).text();
    // chat-restore (webui-simplify §1): the Inbox composer is back...
    expect(body).not.toContain('id="webui-compose"'); // the v2-era id stays retired
    expect(body).toContain('id="webui-input"');
    expect(body).toContain('id="webui-send"');
    expect(body).toContain('id="webui-abort"');
    // ...but the outbound queue machinery — the thing that guarantees a HITL
    // answer is never lost across a WS reconnect — is fully intact in the
    // served HTML.
    expect(body).toContain("wsQueue.push(payload)");
    expect(body).toContain("WebSocket.OPEN");
    expect(body).toContain("sendAppexecResponse(");
  });
});

describe("wireWebui render framework — mirror removal (spec Component 6, Decision B)", () => {
  it("NEGATIVE: registeredTools has NO webui_render; webui_present IS registered", () => {
    const { pi } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tools = pi.registeredTools as Array<{ name: string }>;
    expect(tools.some((t) => t.name === "webui_render")).toBe(false);
    expect(tools.some((t) => t.name === "webui_present")).toBe(true);
  });

  it("NEGATIVE: a tool_result event mints NO 'tools' view (only the outbound broadcast fires)", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // A realistic tool_result on the AGENT bus (pi.on path). Before Phase 5 the
    // mirror rendered this into an accumulating "tools" view; after, the only
    // tool_result handler is the OUTBOUND_EVENTS broadcast loop (this MockPi
    // keeps ONE handler per event, and the broadcast registers LAST).
    pi.emit("tool_result", {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-abcd1234efgh",
      input: {},
      content: [{ type: "text", text: "hello" }],
      isError: false,
    });
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(views).toEqual([]);
  });
});
