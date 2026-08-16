/**
 * nonblocking-cards.test.ts — cards-ux2 (02) scope A wiring: the card_send
 * inbound path for NON-BLOCKING (draft) cards. Protocol sub-shape + blocking
 * flag are pinned in protocol.test.ts; THIS file pins the wiring loop
 * end-to-end: onCommand TOP guard → validate → FIRST-SEND-WINS →
 * channel-tagged JSONL → card_done tombstone → sendMessage delivery (title
 * from the broadcast-path title map) → session_shutdown reset.
 *
 * Harness: shared tests/helpers/mock-pi.ts + a minimal fake server + a memory
 * broadcaster (no live pi, no live Bun.serve, tmp cardsDir).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MockPi } from "./helpers/mock-pi.js";
import { wireWebui, type WebuiServer, type WebuiWiring } from "../src/webui-wiring.js";
import type { ClientFrame, WebFrame } from "../src/protocol.js";

/** Minimal WebuiServer fake — captures the onCommand handler. */
class FakeServer implements WebuiServer {
  readonly frames: WebFrame[] = [];
  private handler: ((frame: ClientFrame, reply: (frame: WebFrame) => void) => void) | null = null;
  startCount = 0;
  bound = false;
  clientCount = 0;
  broadcast(frame: WebFrame): void { this.frames.push(frame); }
  start(): void { this.startCount++; }
  bindSession(): void { this.bound = true; }
  dropSession(): void { this.bound = false; }
  hasSession(): boolean { return this.bound; }
  setCommandHandler(cb: ((frame: ClientFrame, reply: (frame: WebFrame) => void) => void) | null): void { this.handler = cb; }
  setHttpRoutes(): void {}
  setTokenAuth(): void {}
  setWsCloseHandler(): void {}
  setWsOpenHandler(): void {}
  setClientsChangedHandler(): void {}
  get url(): string { return "http://127.0.0.1:12345"; }
  stop(): void { this.bound = false; }
  /** Drive the captured onCommand seam (reply is a no-op sink). */
  command(frame: ClientFrame): void { this.handler!(frame, () => {}); }
}

interface Harness {
  pi: MockPi;
  server: FakeServer;
  sent: string[];
  cardsDir: string;
  wiring: WebuiWiring;
  cardDoneFrames(): WebFrame[];
  broadcastCard(id: string, title: string): void;
  sendCard(cardId: string, answers: Record<string, string>): void;
}

const wirings: WebuiWiring[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  while (wirings.length) { try { wirings.pop()!.dispose(); } catch { /* ignore */ } }
  while (tmpDirs.length) { try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function makeHarness(): Harness {
  const pi = new MockPi();
  const server = new FakeServer();
  const broadcaster = {
    frames: [] as WebFrame[],
    broadcast(frame: WebFrame): void { this.frames.push(frame); },
  };
  const sent: string[] = [];
  const cardsDir = mkdtempSync(path.join(tmpdir(), "nonblocking-cards-"));
  tmpDirs.push(cardsDir);
  const wiring = wireWebui(pi as never, { server, broadcaster, cardsDir, sendMessage: (t) => sent.push(t) });
  wirings.push(wiring);
  pi.emit("session_start", {}); // mint the JSONL session stamp + bind the session
  return {
    pi,
    server,
    sent,
    cardsDir,
    wiring,
    cardDoneFrames: () => broadcaster.frames.filter((f) => f.type === "card_done"),
    // Prime the id→title map through the REAL broadcast path (wiring.broadcaster —
    // the store-wrapped seam every producer card crosses).
    broadcastCard: (id, title) =>
      wiring.broadcaster.broadcast({
        type: "card", id, kind: "interactive", title, source: "test",
        ts: 1, attention: "input", body: { question: "q", fields: [] },
      }),
    sendCard: (cardId, answers) =>
      server.command({ type: "appexec", extra: { kind: "card_send", cardId, answers } }),
  };
}

describe("card_send wiring (cards-ux2 02 scope A)", () => {
  it("card_send → card_done tombstone + sendMessage delivery + channel-tagged JSONL", () => {
    const h = makeHarness();
    h.broadcastCard("c1", "T");
    h.sendCard("c1", { a: "1" });
    expect(h.cardDoneFrames()[0]).toMatchObject({ type: "card_done", id: "c1" }); // cards-ux2 04: now also carries answers rows
    expect(h.sent).toEqual([`[card c1] T: {"a":"1"}`]);
    const stamps = readdirSync(h.cardsDir);
    expect(stamps.length).toBe(1);
    const lines = readFileSync(path.join(h.cardsDir, stamps[0], "cards.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ cardId: "c1", answers: { a: "1" }, channel: "card_send" });
    expect(typeof entry.ts).toBe("number");
  });

  it("FIRST-SEND-WINS: a second card_send for the same id is inert", () => {
    const h = makeHarness();
    h.broadcastCard("c1", "T");
    h.sendCard("c1", { a: "1" });
    h.sendCard("c1", { a: "2" });
    expect(h.cardDoneFrames().length).toBe(1);
    expect(h.sent).toEqual([`[card c1] T: {"a":"1"}`]); // first payload wins
  });

  it("invalid card_send shapes are ignored silently (no tombstone, no send)", () => {
    const h = makeHarness();
    h.broadcastCard("c1", "T");
    h.server.command({ type: "appexec", extra: { kind: "card_send", cardId: "c1", answers: { a: 1 } } });
    h.server.command({ type: "appexec", extra: { kind: "card_send", cardId: "", answers: {} } });
    h.server.command({ type: "appexec", extra: { kind: "card_send", cardId: "c1" } });
    expect(h.cardDoneFrames().length).toBe(0);
    expect(h.sent.length).toBe(0);
    // A later VALID send still delivers (invalid ones never consumed the id).
    h.sendCard("c1", { a: "ok" });
    expect(h.cardDoneFrames().length).toBe(1);
    expect(h.sent).toEqual([`[card c1] T: {"a":"ok"}`]);
  });

  it("session_shutdown clears the ledger — the same id delivers again next session", () => {
    const h = makeHarness();
    h.broadcastCard("c1", "T");
    h.sendCard("c1", { a: "1" });
    expect(h.sent.length).toBe(1);
    h.pi.emit("session_shutdown", {});
    h.broadcastCard("c1", "T2");
    h.sendCard("c1", { a: "2" });
    expect(h.cardDoneFrames().length).toBe(2);
    expect(h.sent).toEqual([`[card c1] T: {"a":"1"}`, `[card c1] T2: {"a":"2"}`]);
  });

  it("default seam: without deps.sendMessage the message rides pi.sendUserMessage", () => {
    const pi = new MockPi();
    const server = new FakeServer();
    const cardsDir = mkdtempSync(path.join(tmpdir(), "nonblocking-cards-"));
    tmpDirs.push(cardsDir);
    const wiring = wireWebui(pi as never, {
      server,
      broadcaster: { frames: [] as WebFrame[], broadcast(): void {} },
      cardsDir,
    });
    wirings.push(wiring);
    pi.emit("session_start", {});
    wiring.broadcaster.broadcast({
      type: "card", id: "c9", kind: "interactive", title: "D", source: "test",
      ts: 1, attention: "input", body: { question: "q", fields: [] },
    });
    server.command({ type: "appexec", extra: { kind: "card_send", cardId: "c9", answers: { x: "y" } } });
    expect(pi.sent.length).toBe(1);
    expect(pi.sent[0].content).toBe(`[card c9] D: {"x":"y"}`);
  });
});
