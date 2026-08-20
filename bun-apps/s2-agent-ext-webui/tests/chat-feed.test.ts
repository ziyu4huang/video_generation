/**
 * chat-feed.test.ts — webui-readability G1: the OTHER half of chat — the
 * assistant's final text must reach the browser, rendered as markdown.
 * Wiring: message_end (the FINAL authoritative message, pi docs json.md)
 * broadcasts ONE {type:"message_end", text} frame per assistant message —
 * the v3 frame diet holds (message_update still broadcasts NOTHING).
 * Route: POST /api/markdown reuses the Report marked pipeline. Shell: an
 * Inbox #chat-feed renders user echo rows + assistant markdown rows in a
 * sandboxed iframe (page-origin innerHTML stays forbidden).
 */
import { describe, expect, test } from "bun:test";
import { MockPi } from "./helpers/mock-pi.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { MemoryBroadcaster } from "../src/broadcaster.js";
import { wireWebui, type WebuiServer } from "../src/webui-wiring.js";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";
import { RenderService } from "../src/render-service.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { WebServer, type CommandHandler, type HttpRouteHandler } from "../src/web-server.js";

class FakeWebServer implements WebuiServer {
  commandHandler: CommandHandler | null = null;
  httpRoutes: HttpRouteHandler | null = null;
  readonly url = "http://fake.local/";
  broadcast(_f: unknown): void {}
  start(): void {}
  bindSession(): void {}
  dropSession(): void {}
  hasSession(): boolean { return true; }
  setCommandHandler(cb: CommandHandler | null): void { this.commandHandler = cb; }
  setHttpRoutes(h: HttpRouteHandler | null): void { this.httpRoutes = h; }
  setTokenAuth(): void {}
  setWsCloseHandler(): void {}
  setWsOpenHandler(): void {}
  stop(): void {}
}

describe("wireWebui — G1 assistant text broadcast", () => {
  function setup() {
    const pi = new MockPi();
    const broadcaster = new MemoryBroadcaster();
    const wiring = wireWebui(pi, { broadcaster, clock: new FakeClock(), server: new FakeWebServer() } as never);
    pi.emit("session_start", { type: "session_start", reason: "startup" }, pi.ctx);
    return { pi, broadcaster, wiring };
  }
  const msg = (text: string) => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

  test("message_end broadcasts ONE final-text frame", () => {
    const { pi, broadcaster } = setup();
    pi.emit("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
    pi.emit("message_end", msg("Hello *world*"));
    const frames = (broadcaster as { frames: Array<{ type: string; text?: string }> }).frames.filter((f) => f.type.startsWith("message"));
    expect(frames).toEqual([{ type: "message_end", text: "Hello *world*" }]);
  });

  test("multi-part content concatenates; empty text broadcasts nothing", () => {
    const { pi, broadcaster } = setup();
    pi.emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } });
    pi.emit("message_end", { type: "message_end", message: { role: "assistant", content: [] } });
    pi.emit("message_end", { type: "message_end", message: undefined });
    const frames = (broadcaster as { frames: Array<{ type: string; text?: string }> }).frames.filter((f) => f.type === "message_end");
    expect(frames).toEqual([{ type: "message_end", text: "ab" }]);
  });
});

describe("POST /api/markdown — G1 Report-pipeline reuse", () => {
  test("renders md -> html; empty/non-string/oversize -> 400", async () => {
    const s = new WebServer({ port: 0 });
    s.setHttpRoutes(createRenderRoutes(new RenderService()));
    s.start();
    try {
      const ok = await fetch(s.url + "/api/markdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "# hi\n\nworld" }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { html: string };
      expect(body.html).toContain("<h1>");

      const empty = await fetch(s.url + "/api/markdown", { method: "POST", body: JSON.stringify({ text: "   " }) });
      expect(empty.status).toBe(400);
      const badType = await fetch(s.url + "/api/markdown", { method: "POST", body: JSON.stringify({ text: 42 }) });
      expect(badType.status).toBe(400);
      const huge = await fetch(s.url + "/api/markdown", { method: "POST", body: JSON.stringify({ text: "x".repeat(600_000) }) });
      expect(huge.status).toBe(400);
    } finally {
      s.stop();
    }
  });
});

describe("RENDER_SHELL_HTML — G1 chat feed literals", () => {
  test("Inbox chat feed: rows, markdown fetch, sandboxed iframe, snapshot clear", () => {
    expect(RENDER_SHELL_HTML).toContain('id="chat-feed"');
    expect(RENDER_SHELL_HTML).toContain("renderChatAssistant");
    expect(RENDER_SHELL_HTML).toContain("fetch('/api/markdown'");
    expect(RENDER_SHELL_HTML).toContain("chat-row user");
    expect(RENDER_SHELL_HTML).toContain("iframe.chat-md");
    expect(RENDER_SHELL_HTML).toContain("sandbox", );
    expect(RENDER_SHELL_HTML).toContain("case 'message_end':");
    expect(RENDER_SHELL_HTML).toContain("chatFeedEl.textContent = ''");
  });
});
