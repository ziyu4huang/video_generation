/**
 * tui-bell-deep-link.test.ts — event-cards (03): TUI attention bell +
 * `#card-<id>` deep link. Grids the two pure halves (cardBellMessage in
 * webui-wiring.ts, parseCardHash in render-shell.ts) and drives the bell's
 * integration point — the STORE-WRAPPED broadcaster inside wireWebui — over
 * the standard MockPi + MemoryBroadcaster + FakeWebServer + FakeClock fixture
 * (no live pi, no Bun.serve).
 *
 * Covers:
 *  - cardBellMessage routing: silent cards NEVER bell; card_done-shaped and
 *    every non-card frame are null; view/input cards produce a message with
 *    the `#card-<id>` deep link (+ title, prefixed by the resolved server
 *    URL; "" degrades to a bare anchor); titles truncate at 60 chars
 *    (57 + "...").
 *  - integration: once a session is BOUND (session_start), broadcasting a
 *    non-silent card through wiring.broadcaster fans out to the injected
 *    broadcaster AND rings ctx.ui.notify exactly once with the deep link;
 *    a follow-up SILENT card and a card_done broadcast add NO notify
 *    (no bell); a card broadcast BEFORE session_start (unbound) neither
 *    throws nor notifies.
 *  - parseCardHash: the five documented cases (two valid id shapes, two
 *    non-card hashes, empty string).
 *  - RENDER_SHELL_HTML: the deep-link wiring literals are shipped in the
 *    shell (hashchange listener, card-flash, handleCardHash, Cards-tab
 *    activation).
 */
import { describe, expect, test } from "bun:test";
import { MockPi } from "./helpers/mock-pi.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { MemoryBroadcaster } from "../src/broadcaster.js";
import { wireWebui, cardBellMessage, type WebuiServer, type WebuiWiring } from "../src/webui-wiring.js";
import { parseCardHash, RENDER_SHELL_HTML } from "../src/render-shell.js";
import { type CommandHandler, type HttpRouteHandler } from "../src/web-server.js";
import type { WebFrame } from "../src/protocol.js";

/** Minimal WebuiServer fake: records lifecycle + holds the command handler. */
class FakeWebServer implements WebuiServer {
  startCalls = 0;
  stopCalls = 0;
  bindCalls = 0;
  dropCalls = 0;
  private bound = false;
  commandHandler: CommandHandler | null = null;
  httpRoutes: HttpRouteHandler | null = null;
  /** Stub URL (urlFor is only read for the real WebServer; never hit here). */
  readonly url = "http://fake.local/";
  /** Unused in tests (a MemoryBroadcaster is injected as the broadcaster). */
  broadcast(_frame: WebFrame): void {}
  start(): void {
    this.startCalls++;
  }
  bindSession(_pi: unknown, _ctx: unknown): void {
    this.bindCalls++;
    this.bound = true;
  }
  dropSession(): void {
    this.dropCalls++;
    this.bound = false;
  }
  hasSession(): boolean {
    return this.bound;
  }
  setCommandHandler(cb: CommandHandler | null): void {
    this.commandHandler = cb;
  }
  setHttpRoutes(handler: HttpRouteHandler | null): void {
    this.httpRoutes = handler;
  }
  setTokenAuth(_token: string | null): void {}
  setWsCloseHandler(_cb: (() => void) | null): void {}
  setWsOpenHandler(_cb: ((ws: unknown) => void) | null): void {}
  stop(): void {
    this.stopCalls++;
  }
}

/** Standard fixture: wiring built over injected fakes (no real Bun.serve). */
function setup() {
  const pi = new MockPi();
  const broadcaster = new MemoryBroadcaster();
  const clock = new FakeClock();
  const server = new FakeWebServer();
  const wiring = wireWebui(pi, { broadcaster, clock, server });
  return { pi, broadcaster, clock, server, wiring };
}

// --- (a) cardBellMessage — pure routing -------------------------------------
describe("cardBellMessage — pure bell routing", () => {
  test("silent card never bells (null)", () => {
    expect(
      cardBellMessage({ type: "card", id: "c1", title: "Muted", attention: "silent" }, "http://fake.local")
    ).toBeNull();
  });

  test("view card → message carries the #card-<id> deep link + title (serverUrl prefix)", () => {
    const msg = cardBellMessage(
      { type: "card", id: "c2", title: "Deploy ready", attention: "view" },
      "http://fake.local"
    );
    expect(msg).not.toBeNull();
    expect(msg!).toContain("Deploy ready");
    expect(msg!).toContain("http://fake.local/#card-c2");
  });

  test("input card → non-null; empty serverUrl degrades to a bare anchor", () => {
    const msg = cardBellMessage({ type: "card", id: "c3", title: "Approve?", attention: "input" }, "");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("#card-c3");
    expect(msg!).not.toContain("://"); // no URL prefix at all
  });

  test("card_done-shaped frame → null (never bells)", () => {
    // card_done carries no title/attention on the wire; even a maximally
    // bell-shaped impostor stays null because type !== "card".
    expect(
      cardBellMessage({ type: "card_done", id: "c3", title: "x", attention: "input" }, "http://fake.local")
    ).toBeNull();
  });

  test("title over 60 chars truncates to 57 + '...'", () => {
    const msg = cardBellMessage({ type: "card", id: "c4", title: "A".repeat(70), attention: "view" }, "");
    expect(msg).not.toBeNull();
    expect(msg!).toContain("A".repeat(57) + "...");
    expect(msg!.includes("A".repeat(58))).toBe(false);
  });
});

// --- (b/c) integration — the store-wrapped broadcaster is the bell point ----
describe("wireWebui — bell at the store-wrapped broadcaster", () => {
  test("bound session: input card → fan-out + exactly ONE notify with deep link; silent + card_done add none", () => {
    const { pi, broadcaster, wiring } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    const card: WebFrame = {
      type: "card",
      id: "card-9",
      kind: "interactive",
      title: "Approve?",
      source: "test",
      ts: 1,
      attention: "input",
      body: { question: "q", fields: [] },
    };
    wiring.broadcaster.broadcast(card);
    // Fan-out survived the bell hop: the frame reached the injected broadcaster.
    const cards = broadcaster.frames.filter((f) => f.type === "card");
    expect(cards).toHaveLength(1);
    expect((cards[0] as { id?: string }).id).toBe("card-9");
    // Exactly one bell, info-level, with the deep link + title + server URL.
    expect(pi.ctx.notifications).toHaveLength(1);
    const n = pi.ctx.notifications[0]!;
    expect(n.type).toBe("info");
    expect(n.message).toContain("Approve?");
    expect(n.message).toContain("#card-card-9");
    expect(n.message).toContain("http://fake.local/#card-card-9");
    // Follow-up SILENT card: broadcast (snapshot-visible) but NO new bell.
    wiring.broadcaster.broadcast({
      type: "card",
      id: "card-10",
      kind: "interactive",
      title: "Silent",
      source: "test",
      ts: 2,
      attention: "silent",
      body: { question: "q", fields: [] },
    });
    expect(pi.ctx.notifications).toHaveLength(1);
    // card_done tombstone: broadcast but NO new bell.
    wiring.broadcaster.broadcast({ type: "card_done", id: "card-9", ts: 3 });
    expect(pi.ctx.notifications).toHaveLength(1);
    expect(broadcaster.frames.some((f) => f.type === "card_done")).toBe(true);
  });

  test("unbound (pre-session_start) card broadcast → no throw, no notify", () => {
    const { pi, broadcaster, wiring } = setup();
    expect(() =>
      wiring.broadcaster.broadcast({
        type: "card",
        id: "card-early",
        kind: "readonly",
        title: "Early",
        source: "test",
        ts: 1,
        attention: "input",
        body: { text: "t" },
      })
    ).not.toThrow();
    expect(pi.ctx.notifications).toHaveLength(0);
    // Fan-out still happened — unbound means "replay-visible only", not dropped.
    expect(broadcaster.frames.some((f) => f.type === "card")).toBe(true);
  });
});

// --- (d) parseCardHash — the pure deep-link parser ---------------------------
describe("parseCardHash", () => {
  test("the five documented cases", () => {
    expect(parseCardHash("#card-card-1")).toBe("card-1");
    expect(parseCardHash("#card-a_b-9")).toBe("a_b-9");
    expect(parseCardHash("#card-<script>")).toBeNull();
    expect(parseCardHash("#cards")).toBeNull();
    expect(parseCardHash("")).toBeNull();
  });
});

// --- (e) RENDER_SHELL_HTML — the shipped deep-link wiring literals -----------
describe("RENDER_SHELL_HTML — deep-link literals", () => {
  test("ships hashchange, card-flash, handleCardHash, toggleCardsTab(true)", () => {
    expect(RENDER_SHELL_HTML).toContain("hashchange");
    expect(RENDER_SHELL_HTML).toContain("card-flash");
    expect(RENDER_SHELL_HTML).toContain("handleCardHash");
    expect(RENDER_SHELL_HTML).toContain("toggleCardsTab(true)");
  });
});
