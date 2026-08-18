/**
 * view-opened-e2e.test.ts — E2E for view notifications (effort
 * 2026-08-16-webui-view-notifications, ticket 08): a `webui:open` emission
 * through the REAL wireWebui drives register → broadcast → notify; the frame
 * is observable by a live WS client AND by a mid-session connect (snapshot
 * replay), with the url-view listed by /api/views.
 *
 * Harness self-contained: helpers lifted from wiring-live-smoke.test.ts
 * (file-local there) + a minimal host stub extended with a real node
 * EventEmitter events bus (the seam the open handler subscribes to).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

/** Minimal host: wiring's declared surface (on/sendUserMessage) + a REAL
 *  events bus (webui:open seam) + a notify capture. */
class MockPi {
  events = new EventEmitter();
  notified: string[] = [];
  private handlers = new Map<string, (data: unknown, ctx: unknown) => void>();
  on(event: string, fn: (data: unknown, ctx: unknown) => void): void { this.handlers.set(event, fn); }
  sendUserMessage(): void { /* not exercised here */ }
  ctx(): unknown { return { ui: { notify: (m: string) => { this.notified.push(m); } } }; }
  emitHost(event: string, data: unknown): void { this.handlers.get(event)?.(data, this.ctx()); }
}

describe("view_opened E2E (ticket 08)", () => {
  it("webui:open → live frame + /api/views url entry + snapshot replay + terminal notify", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "webui-e2e-open-"));
    writeFileSync(path.join(dir, "a.html"), "<html>A</html>");
    const pi = new MockPi();
    const server = new WebServer({ port: 0 });
    started.push(server);
    const wiring = wireWebui(pi as never, { server, fileRoots: [dir] });
    wirings.push(wiring);
    pi.emitHost("session_start", {});
    await waitFor("server started", () => server.port > 0);

    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);

    pi.events.emit("webui:open", { path: path.join(dir, "a.html"), view: "diagram", title: "T" });

    // webui-simplify §3: the registry render fires a view_update frame FIRST
    // (the open registers a url view); scan past it for the view_opened frame.
    const raw = await withTimeout(
      (async () => {
        for (;;) {
          const m = await nextNonSnapshot(ws);
          try { if (JSON.parse(m).type === "view_update") continue; } catch { /* not JSON */ }
          return m;
        }
      })(),
      2000,
      "view_opened frame not delivered"
    );
    const frame = JSON.parse(raw);
    expect(frame.type).toBe("view_opened");
    expect(frame.url).toContain("/files/0/a.html");
    expect(frame.view).toBe("diagram");
    expect(frame.title).toBe("T");
    expect(Math.abs(Date.now() - frame.ts)).toBeLessThan(10_000);

    const res = await fetch(`${server.url}/api/views`);
    const views = (await res.json()) as Array<{ id: string; mode: string }>;
    const entry = views.find((v) => v.id === "url:diagram");
    expect(entry?.mode).toBe("url");

    // Mid-session connect: the snapshot replay carries the view_opened frame.
    const ws2 = new WebSocket(`${server.url.replace("http", "ws")}/ws`);
    openClients.push(ws2);
    const first2 = await withTimeout(new Promise<string>((resolve) => {
      ws2.onmessage = (ev) => resolve(String(ev.data));
    }), 2000, "snapshot not delivered");
    expect(JSON.parse(first2).type).toBe("snapshot");
    expect(first2).toContain("view_opened");

    // Terminal back-compat: notify still fired with the /files URL.
    expect(pi.notified.some((m) => m.includes("/files/0/a.html"))).toBe(true);
  });
});
