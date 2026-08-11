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
  it("registers the webui_render tool + webui:render subscription during wiring", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tools = pi.registeredTools as Array<{ name: string }>;
    expect(tools.some((t) => t.name === "webui_render")).toBe(true);
    // the event subscription routes into the registry: emit -> GET /api/view/:id
    pi.events.emit("webui:render", { content: "# hello", view: "preview", title: "P" });
    const res = await fetch(`${server.url}/api/view/preview`);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.mode).toBe("md");
    expect(v.html).toContain("<h1");
    expect(v.title).toBe("P");
  });

  it("the tool execute() path lands in the same registry and is served", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tool = (pi.registeredTools as Array<{ name: string; execute: (...a: any[]) => Promise<any> }>)
      .find((t) => t.name === "webui_render")!;
    const out = await tool.execute("c1", { content: "**bold**", view: "toolview" }, undefined, undefined, {});
    expect(out.details.url).toContain("/#toolview");
    const v = await (await fetch(`${server.url}/api/view/toolview`)).json();
    expect(v.html).toContain("<strong>bold</strong>");
  });

  it("GET / serves the render shell after wiring", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const body = await (await fetch(`${server.url}/`)).text();
    expect(body).toContain("webui-render-shell");
  });

  it("render() returns the loopback URL composed from server.url", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tool = (pi.registeredTools as Array<{ name: string; execute: (...a: any[]) => Promise<any> }>)
      .find((t) => t.name === "webui_render")!;
    const out = await tool.execute("c", { content: "x", view: "z" }, undefined, undefined, {});
    expect(out.details.url).toBe(`${server.url}/#z`);
  });

  it("GET /api/events SSE delivers a view_update on webui:render", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events`, { signal: ctrl.signal });
    expect(res.headers.get("content-type") || "").toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const first = await withTimeout(reader.read(), 2000, "no initial chunk");
    buf += dec.decode(first.value ?? new Uint8Array(), { stream: true });
    expect(buf).toContain(": connected");
    pi.events.emit("webui:render", { content: "# hi", view: "sse-view" });
    let payload: { viewId?: string; updatedAt?: number } | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !payload) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 40)),
      ]);
      if ("value" in chunk && chunk.value) buf += dec.decode(chunk.value, { stream: true });
      const m = buf.match(/data: (\{.*\})\n\n/);
      if (m) payload = JSON.parse(m[1]);
    }
    expect(payload).toMatchObject({ viewId: "sse-view" });
    ctrl.abort();
  });
});

describe("wireWebui render framework — decoupling (spec D8)", () => {
  it("the render path does NOT call sendUserMessage and does NOT broadcast a mutex_blocked frame", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // Observe any broadcast on the chat WS (mutex_blocked would arrive here).
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);
    let gotFrame = false;
    ws.onmessage = () => { gotFrame = true; };

    // Drive BOTH producer paths.
    pi.events.emit("webui:render", { content: "# via-event" });
    const tool = (pi.registeredTools as Array<{ name: string; execute: (...a: any[]) => Promise<any> }>)
      .find((t) => t.name === "webui_render")!;
    await tool.execute("c", { content: "# via-tool", view: "t" }, undefined, undefined, {});

    await Bun.sleep(100); // give any (absent) broadcast time to never arrive
    expect(pi.sent).toEqual([]); // render never injects a user message
    expect(gotFrame).toBe(false); // no mutex_blocked / no chat frame on the render path
    ws.close();
  });
});
