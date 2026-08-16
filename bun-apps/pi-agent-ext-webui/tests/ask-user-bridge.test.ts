/**
 * ask-user-bridge.test.ts — E2E for the ask-user ↔ webui bridge (effort
 * 2026-08-16-webui-present-adoption §C3, ticket 03): the core-task
 * questionnaire prompt event is mirrored as a replay-eligible `ask_user` WS
 * frame, and a browser answer riding the loose appexec channel is re-emitted
 * on the host bus as `rpiv:ask-user:answer` (which ask-user's execute
 * consumes via its doneRef — covered core-task-side).
 *
 * Harness mirrors view-opened-e2e.test.ts (file-local helpers + a minimal
 * host stub with a REAL EventEmitter bus).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { WebServer } from "../src/web-server.js";
import { wireWebui, type WebuiWiring } from "../src/webui-wiring.js";

const started: WebServer[] = [];
const wirings: WebuiWiring[] = [];
const openClients: WebSocket[] = [];

afterEach(() => {
  while (wirings.length) { try { wirings.pop()!.dispose(); } catch { /* ignore */ } }
  for (const ws of openClients) { try { ws.close(); } catch { /* ignore */ } }
  openClients.length = 0;
  while (started.length) { try { started.pop()!.stop(); } catch { /* ignore */ } }
});

function withTimeout<T>(p: Promise<T>, ms = 2000, label = "timed out"): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms))]);
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
function nextNonSnapshot(ws: WebSocket): Promise<string> {
  return new Promise<string>((resolve) => {
    const handler = (ev: MessageEvent) => {
      const text = String(ev.data);
      try { if (JSON.parse(text).type === "snapshot") return; } catch { /* real frame */ }
      ws.removeEventListener("message", handler);
      resolve(text);
    };
    ws.addEventListener("message", handler);
  });
}

class MockPi {
  events = new EventEmitter();
  notified: string[] = [];
  private handlers = new Map<string, (data: unknown, ctx: unknown) => void>();
  on(event: string, fn: (data: unknown, ctx: unknown) => void): void { this.handlers.set(event, fn); }
  sendUserMessage(): void { /* not exercised here */ }
  ctx(): unknown { return { ui: { notify: (m: string) => { this.notified.push(m); } } }; }
  emitHost(event: string, data: unknown): void { this.handlers.get(event)?.(data, this.ctx()); }
}

describe("ask-user bridge (ticket 03)", () => {
  it("rpiv:ask-user:prompt event → ask_user frame broadcast", async () => {
    const pi = new MockPi();
    const server = new WebServer({ port: 0 });
    started.push(server);
    const wiring = wireWebui(pi as never, { server });
    wirings.push(wiring);
    pi.emitHost("session_start", {});
    await waitFor("server started", () => server.port > 0);

    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    pi.events.emit("rpiv:ask-user:prompt", {
      promptId: "p1",
      questions: [{ question: "Q", header: "H", multiSelect: false, options: [{ label: "a", description: "d" }] }],
    });

    const raw = await withTimeout(nextNonSnapshot(ws), 2000, "ask_user frame not delivered");
    const frame = JSON.parse(raw);
    expect(frame.type).toBe("ask_user");
    expect(frame.promptId).toBe("p1");
    expect(Array.isArray(frame.questions)).toBe(true);
    expect(frame.questions.length).toBe(1);
    expect(Math.abs(Date.now() - frame.ts)).toBeLessThan(10_000);
  });

  it("inbound appexec ask_user_answer → rpiv:ask-user:answer on host bus", async () => {
    const pi = new MockPi();
    const server = new WebServer({ port: 0 });
    started.push(server);
    const wiring = wireWebui(pi as never, { server });
    wirings.push(wiring);
    pi.emitHost("session_start", {});
    await waitFor("server started", () => server.port > 0);

    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    let captured: { promptId?: string; result?: unknown } | undefined;
    pi.events.on("rpiv:ask-user:answer", (p: { promptId?: string; result?: unknown }) => { captured = p; });

    ws.send(JSON.stringify({ type: "appexec", extra: { kind: "ask_user_answer", promptId: "p1", result: { answers: [] } } }));
    await waitFor("answer re-emitted on host bus", () => captured !== undefined);
    expect(captured?.promptId).toBe("p1");
    expect(Array.isArray((captured?.result as { answers?: unknown[] })?.answers)).toBe(true);
  });
});
