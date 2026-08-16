/**
 * pilot-cards.test.ts — event-cards (05): v1 pilot wiring — the questionnaire
 * ask card (dual broadcast + card_done retire) and the archify view cards
 * (webui:open / event-originated webui:present). Wiring half drives wireWebui
 * over the standard MockPi + MemoryBroadcaster + FakeWebServer + FakeClock
 * fixture (no live pi, no Bun.serve — the MemoryBroadcaster captures the
 * store-wrapped stream in order). Shell half grids the pure twins + inline
 * literals over RENDER_SHELL_HTML slices (no DOM in this env — same fallback
 * as render-shell-cards.test.ts).
 *
 * Covers:
 *  - ask prompt DUAL broadcast: the ask_user frame AND the interactive card
 *    (id ask-<promptId>, attention input, source ask-user; fields mapped —
 *    select from option labels, text for option-less questions; cap 8).
 *  - ask card submit (shell): the ask_user_answer appexec envelope (NOT
 *    card_answer) with promptId = cardId minus the ask- prefix and proper
 *    {questionIndex, question, kind, answer} rows; generic cards keep
 *    card_answer unchanged.
 *  - rpiv:ask-user:answered → card_done for ask-<promptId> (Set-guarded:
 *    only broadcast cards retire, first fire wins, cleared on
 *    session_shutdown).
 *  - webui:open → readonly archify card (attention view) whose body.url is
 *    the RESOLVED view_opened url; webui:present id-less payloads likewise
 *    (url via the open-side view cache; unknown view omits url); present
 *    payloads carrying an id (the webui_present tool) announce NO card.
 *  - readonly card with body.url renders a createElement anchor (property
 *    assignment only) — no markup sink on the card path.
 *  - Bell/deep-link behavior for the new cards: covered by t03
 *    (cardBellMessage rings for non-silent cards incl. attention
 *    input/view — the pilots add no new bell code).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MockPi } from "./helpers/mock-pi.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { MemoryBroadcaster } from "../src/broadcaster.js";
import { wireWebui, askCardFields, type WebuiServer, type WebuiWiring } from "../src/webui-wiring.js";
import { APPEXEC_ASK_CARD_ANSWER, RENDER_SHELL_HTML } from "../src/render-shell.js";
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
function setup(fileRoots?: string[]) {
  const pi = new MockPi();
  const broadcaster = new MemoryBroadcaster();
  const clock = new FakeClock();
  const server = new FakeWebServer();
  const wiring = wireWebui(pi, { broadcaster, clock, server, ...(fileRoots ? { fileRoots } : {}) });
  return { pi, broadcaster, clock, server, wiring };
}

const tmpRoots: string[] = [];
afterAll(() => {
  while (tmpRoots.length) {
    try { rmSync(tmpRoots.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Make a temp file root containing one servable a.html. */
function makeRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pilot-cards-"));
  tmpRoots.push(dir);
  writeFileSync(path.join(dir, "a.html"), "<html></html>");
  return dir;
}

const ONE_QUESTION_PAYLOAD = {
  promptId: "p1",
  questions: [
    {
      question: "Pick a color",
      header: "Color",
      multiSelect: false,
      options: [
        { label: "red", description: "warm" },
        { label: "blue", description: "cool" },
      ],
    },
    { question: "Any vibe notes?", header: "Vibe", multiSelect: false, options: [] },
  ],
};

// --- wiring: questionnaire ask card (dual broadcast) --------------------------
describe("ask-user pilot — dual broadcast on rpiv:ask-user:prompt", () => {
  test("prompt broadcasts the ask_user frame AND the interactive ask card", () => {
    const { pi, broadcaster } = setup();
    pi.events.emit("rpiv:ask-user:prompt", ONE_QUESTION_PAYLOAD);

    const askUser = broadcaster.frames.find((f) => f.type === "ask_user");
    expect(askUser).toBeDefined(); // the pre-existing mirror is untouched

    const card = broadcaster.frames.find(
      (f) => f.type === "card" && (f as { id?: string }).id === "ask-p1",
    ) as
      | {
          kind: string;
          title: string;
          source: string;
          attention: string;
          body: { question: string; fields: Array<{ name: string; label: string; type: string; options?: string[] }> };
        }
      | undefined;
    expect(card).toBeDefined();
    expect(card!.kind).toBe("interactive");
    expect(card!.title).toBe("Questionnaire");
    expect(card!.source).toBe("ask-user");
    expect(card!.attention).toBe("input");
    expect(card!.body.question).toBe("Answer the questionnaire");
    // field mapping: option-bearing question -> select (labels only), option-less -> text
    expect(card!.body.fields).toEqual([
      { name: "q0", label: "Pick a color", type: "select", options: ["red", "blue"] },
      { name: "q1", label: "Any vibe notes?", type: "text" },
    ]);
  });

  test("askCardFields caps at 8 fields and degrades on malformed questions", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      question: `Q${i + 1}`,
      options: [{ label: `opt${i}` }],
    }));
    expect(askCardFields(many)).toHaveLength(8);
    expect(askCardFields(many)[7]).toEqual({ name: "q7", label: "Q8", type: "select", options: ["opt7"] });
    // malformed entries degrade (text field / dropped non-string labels), never throw
    expect(askCardFields(null)).toEqual([]);
    expect(askCardFields([undefined, { question: "ok" }])).toEqual([
      { name: "q0", label: "Question 1", type: "text" },
      { name: "q1", label: "ok", type: "text" },
    ]);
    expect(askCardFields([{ question: "x", options: [{ label: "a" }, { nope: 1 }, "junk"] }])).toEqual([
      { name: "q0", label: "x", type: "select", options: ["a"] },
    ]);
  });
});

// --- wiring: answered tombstone ------------------------------------------------
describe("ask-user pilot — card_done retire on rpiv:ask-user:answered", () => {
  test("answered broadcasts card_done for the ask card (after ask_user_done)", () => {
    const { pi, broadcaster } = setup();
    pi.events.emit("rpiv:ask-user:prompt", ONE_QUESTION_PAYLOAD);
    broadcaster.frames.length = 0; // isolate the answered emission
    pi.events.emit("rpiv:ask-user:answered", { promptId: "p1" });

    expect(broadcaster.frames.map((f) => f.type)).toEqual(["ask_user_done", "card_done"]);
    expect((broadcaster.frames[1] as { id: string }).id).toBe("ask-p1");
  });

  test("Set-guarded: no card for unknown promptIds, first fire wins, shutdown clears", () => {
    const { pi, broadcaster } = setup();
    // answered for a promptId whose card was never broadcast -> no tombstone
    pi.events.emit("rpiv:ask-user:answered", { promptId: "ghost" });
    expect(broadcaster.frames.some((f) => f.type === "card_done")).toBe(false);

    pi.events.emit("rpiv:ask-user:prompt", ONE_QUESTION_PAYLOAD);
    pi.events.emit("rpiv:ask-user:answered", { promptId: "p1" });
    // duplicate answered -> the first fire already deleted the ledger entry
    pi.events.emit("rpiv:ask-user:answered", { promptId: "p1" });
    expect(broadcaster.frames.filter((f) => f.type === "card_done")).toHaveLength(1);

    // session_shutdown clears the ledger: a stray late answered is a no-op
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "exit" });
    broadcaster.frames.length = 0;
    pi.events.emit("rpiv:ask-user:answered", { promptId: "p1" });
    expect(broadcaster.frames.some((f) => f.type === "card_done")).toBe(false);
    expect(broadcaster.frames.some((f) => f.type === "ask_user_done")).toBe(true); // mirror unaffected
  });
});

// --- wiring: archify cards ------------------------------------------------------
describe("archify pilot — webui:open / webui:present cards", () => {
  test("webui:open broadcasts the view_opened frame AND a readonly card with the resolved url", () => {
    const root = makeRoot();
    const { pi, broadcaster } = setup([root]);
    pi.events.emit("webui:open", { path: path.join(root, "a.html"), view: "diagram", title: "T" });

    const opened = broadcaster.frames.find((f) => f.type === "view_opened");
    expect(opened).toBeDefined(); // the pre-existing notification is untouched
    const card = broadcaster.frames.find(
      (f) => f.type === "card" && (f as { id?: string }).id === "archify-diagram",
    ) as
      | {
          kind: string;
          title: string;
          source: string;
          attention: string;
          body: { text: string; url?: string };
        }
      | undefined;
    expect(card).toBeDefined();
    expect(card!.kind).toBe("readonly");
    expect(card!.title).toBe("T");
    expect(card!.source).toBe("archify");
    expect(card!.attention).toBe("view");
    expect(card!.body.text).toBe("archify view ready");
    // deep link = the RESOLVED /files url from the view_opened frame (fake
    // server url, trailing slash stripped by the wiring's lazy getUrl)
    expect(card!.body.url).toBe("http://fake.local/files/0/a.html");
  });

  test("webui:present: id-less payloads announce the SAME card id (url from the open-side cache); id-carrying tool payloads never announce", () => {
    const root = makeRoot();
    const { pi, broadcaster } = setup([root]);
    // open first (archify's actual order) — caches view -> url
    pi.events.emit("webui:open", { path: path.join(root, "a.html"), view: "diagram", title: "T" });
    // the webui_present tool's payload carries an id — its HITL surface is the
    // presentation itself, so NO archify card may be announced
    pi.events.emit("webui:present", {
      content: "approve?",
      controls: [{ id: "approve", label: "Approve" }],
      id: "pres-1",
    });
    // the event-originated (archify) payload — no id -> announce, same id as
    // the open card (renderCard dom-id dedupe -> replace-only, never a pair)
    pi.events.emit("webui:present", {
      path: path.join(root, "a.html"),
      view: "diagram",
      title: "T",
      controls: [{ id: "approve", label: "Approve" }],
    });
    const cards = broadcaster.frames.filter(
      (f) => f.type === "card" && (f as { id?: string }).id === "archify-diagram",
    ) as Array<{ body: { url?: string } }>;
    expect(cards).toHaveLength(2); // open + present, same id
    expect(cards.every((c) => c.body.url === "http://fake.local/files/0/a.html")).toBe(true);
  });

  test("webui:present for an unknown view omits the optional url (no open ran first)", () => {
    const { pi, broadcaster } = setup();
    pi.events.emit("webui:present", { path: "/x/y.html", view: "never-opened", title: "U" });
    const card = broadcaster.frames.find(
      (f) => f.type === "card" && (f as { id?: string }).id === "archify-never-opened",
    ) as { body: { text: string; url?: string } } | undefined;
    expect(card).toBeDefined();
    expect(card!.body).toEqual({ text: "archify view ready" }); // url key absent
  });

  test("webui:open outside the roots announces NO card (fail-closed containment)", () => {
    const root = makeRoot();
    const { pi, broadcaster } = setup([root]);
    pi.events.emit("webui:open", { path: "/etc/passwd", view: "evil" });
    expect(broadcaster.frames.some((f) => f.type === "view_opened")).toBe(false);
    expect(broadcaster.frames.some((f) => f.type === "card")).toBe(false);
  });
});

// --- shell: ask-card submit envelope + url anchor --------------------------------
/** Slice the in-string ask-card form path (isAskCard -> retireCard). */
function askCardFormSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function isAskCard(id)");
  const end = RENDER_SHELL_HTML.indexOf("function retireCard(frame)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

describe("shell — ask-card submit rides ask_user_answer (unify choice)", () => {
  test("ask-card ids branch to the ask_user_answer envelope; generic cards keep card_answer", () => {
    const src = askCardFormSrc();
    // the id discriminator (pilot cards are ask-<promptId>)
    expect(src).toContain("/^ask-/.test(id)");
    // the pinned ask envelope: promptId = cardId minus the ask- prefix, proper
    // QuestionAnswer rows the ask-user envelope formatter consumes
    expect(src).toContain("kind: 'ask_user_answer', promptId: cardId.slice(4)");
    expect(src).toContain("questionIndex: i");
    expect(src).toContain("kind: f.type === 'select' ? 'option' : 'custom'");
    // the generic path is UNCHANGED — one answer path per card kind
    expect(src).toContain(
      "sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'card_answer', cardId: cardId, answers: answers } }));",
    );
    // both envelopes ride sendRaw (queue-while-reconnecting), never raw ws.send
    expect(src).not.toContain("ws.send(");
  });

  test("APPEXEC_ASK_CARD_ANSWER pure twin: promptId + QuestionAnswer rows (null for unfilled)", () => {
    expect(
      APPEXEC_ASK_CARD_ANSWER(
        "ask-p9",
        { q0: "red" },
        [
          { name: "q0", label: "Pick a color", type: "select" },
          { name: "q1", label: "Any vibe notes?", type: "text" },
        ],
      ),
    ).toEqual({
      type: "appexec",
      extra: {
        kind: "ask_user_answer",
        promptId: "p9",
        result: {
          cancelled: false,
          answers: [
            { questionIndex: 0, question: "Pick a color", kind: "option", answer: "red" },
            { questionIndex: 1, question: "Any vibe notes?", kind: "custom", answer: null },
          ],
        },
      },
    });
  });
});

describe("shell — readonly card body.url anchor", () => {
  test("renderCard builds a createElement anchor (property assignment only, guarded typecheck)", () => {
    const start = RENDER_SHELL_HTML.indexOf("function renderCard(frame)");
    const end = RENDER_SHELL_HTML.indexOf("function isAskCard(id)");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const src = RENDER_SHELL_HTML.slice(start, end);
    // guard: url must be a non-empty string before the anchor is built
    expect(src).toContain("typeof frame.body.url === 'string' && frame.body.url");
    // createElement + property assignment ONLY — no markup sink exists
    expect(src).toContain("document.createElement('a')");
    expect(src).toContain("link.href = frame.body.url;");
    expect(src).toContain("link.textContent = frame.body.url;");
    expect(src).toContain("link.target = '_blank';");
    expect(src).toContain("link.rel = 'noopener';");
    expect(src).toContain("body.appendChild(link);");
    for (const sink of ["innerHTML", "insertAdjacentHTML", "outerHTML", "setAttribute('href"]) {
      expect(src).not.toContain(sink);
    }
  });
});
