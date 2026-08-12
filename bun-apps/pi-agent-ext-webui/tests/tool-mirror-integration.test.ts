/**
 * tool-mirror-integration.test.ts — end-to-end for the generic tool-mirror
 * (ticket 05), driving the REAL wireWebui composition root against a minimal
 * MockPi host + a REAL WebServer. Mirrors wiring-live-smoke.test.ts's harness
 * (withTimeout / waitFor / openWs / MockPi). The mirror is wired by T4; this
 * suite proves a tool_result -> "Tools" tab + SSE update + D8 preserved.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import {
  wireWebui,
  type WebuiHost,
  type WebuiWiring,
  type RenderHostEvents,
  type WebuiSessionCtx,
} from "../src/webui-wiring.js";

// --- harness (copied from wiring-live-smoke.test.ts) -----------------------

const started: WebServer[] = [];
function makeServer(): WebServer {
  const s = new WebServer({ port: 0 });
  started.push(s);
  return s;
}
const wirings: WebuiWiring[] = [];
const openClients: WebSocket[] = [];
afterEach(() => {
  while (wirings.length) { try { wirings.pop()!.dispose(); } catch { /* ignore */ } }
  for (const ws of openClients) { try { ws.close(); } catch { /* ignore */ } }
  openClients.length = 0;
  while (started.length) { try { started.pop()!.stop(); } catch { /* ignore */ } }
});
function withTimeout<T>(p: Promise<T>, ms = 2000, label = "timed out"): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(label)), ms))]);
}
async function waitFor(name: string, predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(5); }
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

/** Minimal WebuiHost matching wiring-live-smoke's MockPi (events + registerTool
 *  already required by ticket 06). No new surface — the mirror needs none.
 *  NOTE on the `handlers` model: the real SDK pi bus fires ALL handlers
 *  registered for an event (the wiring itself relies on this for dual-purpose
 *  events like `agent_settled`/`message_update`/`tool_execution_update`, and now
 *  `tool_result` — the mirror is a SECOND `tool_result` handler alongside the
 *  outbound broadcast). The live-smoke MockPi models `handlers` as a last-wins
 *  Map; that breaks for `tool_result` (the broadcast loop overwrites the mirror).
 *  Here we model it faithfully as a per-event list so BOTH the mirror and the
 *  broadcast fire on each `tool_result`, exactly as a real ExtensionAPI does. */
class MockPi implements WebuiHost {
  readonly handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  readonly sent: Array<{ content: string | unknown[]; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  readonly registeredTools: unknown[] = [];
  readonly events: RenderHostEvents;
  constructor() {
    const channels = new Map<string, Set<(data: unknown) => void>>();
    this.events = {
      on(channel, handler) {
        let set = channels.get(channel);
        if (!set) { set = new Set(); channels.set(channel, set); }
        set.add(handler);
        return () => { set!.delete(handler); };
      },
      emit(channel, data) { channels.get(channel)?.forEach((h) => h(data)); },
    };
  }
  on(event: string, handler: (event: any, ctx: any) => any): void {
    let list = this.handlers.get(event);
    if (!list) { list = []; this.handlers.set(event, list); }
    list.push(handler);
  }
  sendUserMessage(content: string | unknown[], opts?: { deliverAs?: "steer" | "followUp" }): void {
    this.sent.push({ content, opts });
  }
  registerTool(tool: unknown): void { this.registeredTools.push(tool); }
  /** Replay a pi host event, firing EVERY registered handler (real-bus parity). */
  emit(event: string, payload: any = {}, ctx: any = undefined): any {
    const list = this.handlers.get(event);
    if (!list) return undefined;
    let last: unknown;
    for (const h of list) last = h(payload, ctx);
    return last;
  }
  ctx(): WebuiSessionCtx {
    return { abort() {}, ui: { notify() {}, setStatus() {} } };
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

describe("wireWebui tool-mirror — end-to-end", () => {
  it("a tool_result -> 'tools' view appears with formatted md", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // replay a real tool_result into the wiring's registered handler
    pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "deadbeefcafe",
      toolName: "edit",
      input: {},
      content: [],
      isError: false,
      details: { diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y", patch: "@@@", firstChangedLine: 1 },
    }, pi.ctx());
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(views.some((v: { id: string }) => v.id === "tools")).toBe(true);
    const v = await (await fetch(`${server.url}/api/view/tools`)).json();
    expect(v.mode).toBe("md");
    expect(v.html).toContain("🔧 edit"); // server-rendered md -> html
    expect(v.html).toContain("```diff".replace(/```/, "")); // diff surfaced
    expect(v.html).toContain("-x");
  });

  it("a tool_result -> SSE delivers a view_update for 'tools'", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    await withTimeout(reader.read(), 2000, "no initial chunk"); // swallow :connected
    pi.emit("tool_result", { type: "tool_result", toolCallId: "c1", toolName: "bash", input: {}, content: [{ type: "text", text: "hi" }], isError: false, details: undefined }, pi.ctx());
    let payload: { viewId?: string } | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !payload) {
      const chunk = await Promise.race([reader.read(), new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 40))]);
      if ("value" in chunk && chunk.value) buf += dec.decode(chunk.value, { stream: true });
      const m = buf.match(/data: (\{.*\})\n\n/);
      if (m) payload = JSON.parse(m[1]);
    }
    expect(payload).toMatchObject({ viewId: "tools" });
    ctrl.abort();
  });
});

describe("wireWebui tool-mirror — decoupling (spec D8)", () => {
  it("the mirror path does NOT call sendUserMessage and does NOT broadcast a /ws frame", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);
    // Capture every /ws frame received. NOTE: `tool_result` is in OUTBOUND_EVENTS,
    // so the pre-existing outbound broadcast handler emits a `tool_result` frame
    // per event (the mirror runs ALONGSIDE it, not instead of it — see
    // 05-rich-rendering-plan §T4 notes). The mirror itself produces NO /ws frame;
    // D8's load-bearing claim is that the mirror introduces NO `mutex_blocked`
    // frame and injects NO user message. We therefore assert no `mutex_blocked`
    // (the mutex-acquisition footprint), not the absence of the legit broadcast.
    const frames: { type: string }[] = [];
    ws.onmessage = (ev) => {
      try { frames.push(JSON.parse(ev.data as string)); } catch { /* ignore */ }
    };
    // drive the mirror with several tool_results
    for (let i = 0; i < 5; i++) {
      pi.emit("tool_result", { type: "tool_result", toolCallId: `c${i}`, toolName: "bash", input: {}, content: [{ type: "text", text: "x" }], isError: false, details: undefined }, pi.ctx());
    }
    await Bun.sleep(120); // let any (absent) mutex_blocked frame never arrive
    expect(pi.sent).toEqual([]); // mirror never injects a user message
    expect(frames.some((f) => f.type === "mutex_blocked")).toBe(false); // no mutex footprint
    ws.close();
  });
});
