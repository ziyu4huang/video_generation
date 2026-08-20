/**
 * chat-restore.test.ts — webui-simplify §1 (PR1): the browser is a thin
 * second client again. Grids the revived agentic dispatch (prompt/steer/
 * followUp -> the sendMessage seam with deliverAs; abort -> the session
 * context abort slice) and the shipped composer literals (Inbox-only input
 * + Send + Abort, IME-safe Enter, prompt frame on the wire).
 *
 * Mutex doctrine is UNCHANGED and untested here: pi.sendUserMessage fires
 * the host `input` event which IS the gate (block => "handled" suppression
 * + mutex_blocked broadcast) — MockPi mirrors that gate faithfully.
 */
import { describe, expect, test } from "bun:test";
import { MockPi } from "./helpers/mock-pi.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { MemoryBroadcaster } from "../src/broadcaster.js";
import { wireWebui, type WebuiServer, type WebuiWiring } from "../src/webui-wiring.js";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";
import { type CommandHandler, type HttpRouteHandler } from "../src/web-server.js";

/** Minimal WebuiServer fake (same shape as tui-bell-deep-link's). */
class FakeWebServer implements WebuiServer {
  startCalls = 0;
  stopCalls = 0;
  bindCalls = 0;
  dropCalls = 0;
  private bound = false;
  commandHandler: CommandHandler | null = null;
  httpRoutes: HttpRouteHandler | null = null;
  readonly url = "http://fake.local/";
  broadcast(_frame: unknown): void {}
  start(): void { this.startCalls++; }
  bindSession(_pi: unknown, _ctx: unknown): void { this.bindCalls++; this.bound = true; }
  dropSession(): void { this.dropCalls++; this.bound = false; }
  hasSession(): boolean { return this.bound; }
  setCommandHandler(cb: CommandHandler | null): void { this.commandHandler = cb; }
  setHttpRoutes(handler: HttpRouteHandler | null): void { this.httpRoutes = handler; }
  setTokenAuth(_token: string | null): void {}
  setWsCloseHandler(_cb: (() => void) | null): void {}
  setWsOpenHandler(_cb: ((ws: unknown) => void) | null): void {}
  stop(): void { this.stopCalls++; }
  clientCount = 0;
}

function setup() {
  const pi = new MockPi();
  const broadcaster = new MemoryBroadcaster();
  const clock = new FakeClock();
  const server = new FakeWebServer();
  const sent: Array<{ text: string; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  const wiring = wireWebui(pi, {
    broadcaster,
    clock,
    server,
    sendMessage: (text, opts) => sent.push({ text, opts }),
  } as never);
  pi.emit("session_start", { type: "session_start", reason: "startup" }, pi.ctx);
  return { pi, broadcaster, server, wiring, sent };
}

describe("wireWebui — revived agentic dispatch", () => {
  test("prompt routes through the sendMessage seam with no deliverAs", () => {
    const { server, sent } = setup();
    server.commandHandler?.({ type: "prompt", text: "hello" } as never, () => {});
    expect(sent).toEqual([{ text: "hello", opts: undefined }]);
  });

  test("steer and followUp map to deliverAs", () => {
    const { server, sent } = setup();
    server.commandHandler?.({ type: "steer", text: "mid-turn nudge" } as never, () => {});
    server.commandHandler?.({ type: "followUp", text: "queue next" } as never, () => {});
    expect(sent).toEqual([
      { text: "mid-turn nudge", opts: { deliverAs: "steer" } },
      { text: "queue next", opts: { deliverAs: "followUp" } },
    ]);
  });

  test("abort reaches the session context abort slice", () => {
    const { pi, server } = setup();
    expect(pi.ctx.abortCalls).toBe(0);
    server.commandHandler?.({ type: "abort" } as never, () => {});
    expect(pi.ctx.abortCalls).toBe(1);
  });
});

describe("RENDER_SHELL_HTML — the shipped Inbox composer", () => {
  test("input + Send + Abort ids ship, wired to prompt/abort frames with the IME guard", () => {
    expect(RENDER_SHELL_HTML).toContain('id="webui-input"');
    expect(RENDER_SHELL_HTML).toContain('id="webui-send"');
    expect(RENDER_SHELL_HTML).toContain('id="webui-abort"');
    expect(RENDER_SHELL_HTML).toContain('id="composer"');
    expect(RENDER_SHELL_HTML).toContain("type: 'prompt'");
    expect(RENDER_SHELL_HTML).toContain("type: 'abort'");
    expect(RENDER_SHELL_HTML).toContain("isComposing");
  });
});
