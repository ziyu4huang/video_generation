/**
 * webui-wiring.test.ts — RED tests for the Task 3b composition root
 * (src/webui-wiring.ts `wireWebui`). Drives the wiring through a MockPi +
 * MemoryBroadcaster + FakeWebServer + FakeClock with NO live pi and NO
 * Bun.serve, per specs/04 §6 and the task-3b contract.
 *
 * Covers:
 *  - construction registers the expected pi.on event SET (gate + lifecycle +
 *    outbound) and the dual-purpose events (agent_settled, message_update)
 *    each register TWO handlers (gate + broadcast).
 *  - input gate handler return shape: {action:"continue"} when idle (web
 *    acquires), {action:"handled"} + mutex_blocked broadcast when "tui"
 *    driving.
 *  - outbound broadcast: a tool_execution_end with .details is mapped 1:1 to a
 *    WebFrame and broadcast.
 *  - lifecycle: session_start starts the server + binds (hasSession true);
 *    session_shutdown drops the session (hasSession false) but does NOT stop
 *    the server.
 *  - inbound dispatch: prompt/steer/followUp/abort/appexec/control.
 *  - NO-SESSION guard: before session_start, an agentic command is rejected
 *    with a no_session reply, never derefs a null session.
 *  - BLOCK FEEDBACK IS BROADCAST: a web command while "tui" driving is
 *    swallowed (no delivered sendUserMessage) AND a mutex_blocked frame is
 *    broadcast; NO per-command ack frame.
 *  - dispose() neutralizes every handler + stops the server.
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MockPi } from "./helpers/mock-pi.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { MemoryBroadcaster } from "../src/broadcaster.js";
import { wireWebui, type WebuiServer, type WebuiWiring } from "../src/webui-wiring.js";
import { WebServer, type CommandHandler, type HttpRouteHandler } from "../src/web-server.js";
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
  /** Recorded token-auth call (ticket 07 D1); default null (loopback off). */
  tokenAuth: string | null = null;
  /** Recorded WS-close handler (spec Component 1; the test fires it to assert abort). */
  wsCloseHandler: (() => void) | null = null;
  /** Recorded WS-open handler (v2 snapshot seam). */
  wsOpenHandler: ((ws: unknown) => void) | null = null;
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
  setTokenAuth(token: string | null): void {
    this.tokenAuth = token;
  }
  setWsCloseHandler(cb: (() => void) | null): void {
    this.wsCloseHandler = cb;
  }
  setWsOpenHandler(cb: ((ws: unknown) => void) | null): void {
    this.wsOpenHandler = cb;
  }
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

/** Synthesize + dispatch an inbound ClientFrame through the recorded seam. */
function dispatch(pi: MockPi, server: FakeWebServer, frame: unknown): WebFrame[] {
  const replies: WebFrame[] = [];
  // The wiring set exactly one command handler on the server.
  expect(server.commandHandler).not.toBeNull();
  server.commandHandler!(frame as any, (f) => replies.push(f));
  return replies;
}

// --- Phase 4: chained httpRoutes seam (render ?? output) ---------------------
describe("wireWebui — chained render+output http routes", () => {
  test("seam serves /output/0/... via deps.outputDir; render routes still first", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "webui-wiring-out-"));
    const outDir = path.join(tmpRoot, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "shot.png"), "PNG");
    try {
      const pi = new MockPi();
      const server = new FakeWebServer();
      wireWebui(pi, { broadcaster: new MemoryBroadcaster(), clock: new FakeClock(), server, outputDir: outDir });
      const handler = server.httpRoutes!;
      expect(handler).not.toBeNull();
      // Render route still consulted first: /api/views answers through the chain.
      const views = handler(new Request("http://t/api/views"), undefined as never);
      expect(views).not.toBeNull();
      expect(views!.status).toBe(200);
      // Output route serves behind it via the injected dir.
      const res = handler(new Request("http://t/output/0/shot.png"), undefined as never);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get("content-type")).toBe("image/png");
      // Fall-through preserved for unknown paths.
      expect(handler(new Request("http://t/definitely/not/a/route"), undefined as never)).toBeNull();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("wireWebui — construction", () => {
  test("registers the expected pi.on event SET", () => {
    const { pi } = setup();
    const expected = [
      "input",
      "agent_settled",
      "message_update",
      "tool_execution_update",
      "session_start",
      "session_shutdown",
      // outbound broadcast set
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "tool_result",
      "turn_start",
      "turn_end",
      "session_before_compact",
      "session_compact",
    ];
    expect(pi.registeredEvents().sort()).toEqual([...expected].sort());
  });

  test("dual-purpose events register BOTH a gate and a broadcast handler", () => {
    const { pi } = setup();
    expect(pi.handlersFor("agent_settled")).toHaveLength(2);
    expect(pi.handlersFor("message_update")).toHaveLength(2);
    // tool_execution_update is dual-purpose too (activity gate + outbound frame).
    expect(pi.handlersFor("tool_execution_update")).toHaveLength(2);
  });

  test("installs the inbound command handler on the server", () => {
    const { server } = setup();
    expect(server.commandHandler).toBeInstanceOf(Function);
  });
});

describe("wireWebui — input gate handler", () => {
  test("idle: {source:'extension'} acquires the lock → {action:'continue'}", () => {
    const { pi } = setup();
    const h = pi.handlersFor("input")[0];
    const result = h({ type: "input", source: "extension", text: "hi" }, {});
    expect(result).toEqual({ action: "continue" });
  });

  test("'tui' driving: {source:'extension'} is blocked → {action:'handled'} + mutex_blocked", () => {
    const { pi, broadcaster } = setup();
    const h = pi.handlersFor("input")[0];
    // tui acquires first
    h({ type: "input", source: "interactive", text: "x" }, {});
    broadcaster.frames.length = 0;
    const result = h({ type: "input", source: "extension", text: "y" }, {});
    expect(result).toEqual({ action: "handled" });
    expect(broadcaster.frames).toContainEqual({
      type: "mutex_blocked",
      blocked: "web",
      by: "tui",
    });
  });
});

describe("wireWebui — outbound broadcast", () => {
  test("tool_execution_end with .details is mapped 1:1 and broadcast", () => {
    const { pi, broadcaster } = setup();
    const evt = {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { exit: 0 },
      isError: false,
      details: { stdout: "ok" },
    };
    pi.emit("tool_execution_end", evt);
    expect(broadcaster.frames).toContainEqual({ ...evt });
  });
});

/**
 * Behavioral coverage for the DUAL-purpose events (specs/04 §3/§4). Registration
 * alone (2 handlers) is not enough — assert each event has BOTH effects:
 *  - message_update / tool_execution_update: tick controller activity
 *    (handleActivity → bumpActivity) AND broadcast a mapEvent frame.
 *  - agent_settled: release the mutex (handleSettled) AND broadcast a frame.
 *
 * Activity is observed via the watchdog: bumpActivity resets `lastActivity`, so
 * advancing past the ORIGINAL stale point must NOT force-release. Were the gate
 * handler unwired, lastActivity would stay frozen and the watchdog would fire.
 */
describe("wireWebui — dual-purpose behavior (gate effect + broadcast)", () => {
  test("message_update BOTH ticks activity AND broadcasts a frame", () => {
    const { pi, broadcaster, clock } = setup();
    // Acquire the lock as web (starts the watchdog, lastActivity = 0).
    const gate = pi.handlersFor("input")[0];
    gate({ type: "input", source: "extension", text: "x" }, pi.ctx);
    broadcaster.frames.length = 0;
    // Advance to just-shy of stale (staleMs = 600_000; interval 1000).
    clock.advance(599_000);
    // Emit message_update → handleActivity bumps + broadcast handler forwards.
    pi.emit("message_update", { type: "message_update", text: "partial" });
    expect(broadcaster.frames).toContainEqual({ type: "message_update", text: "partial" });
    // Activity effect: past the original stale point (0 + 600_000) with no release.
    clock.advance(1_000);
    const forceReleases = broadcaster.frames.filter((f) => f.type === "mutex_force_release");
    expect(forceReleases).toHaveLength(0); // lastActivity was reset → no stale
  });

  test("tool_execution_update BOTH ticks activity AND broadcasts a frame", () => {
    const { pi, broadcaster, clock } = setup();
    const gate = pi.handlersFor("input")[0];
    gate({ type: "input", source: "extension", text: "x" }, pi.ctx);
    broadcaster.frames.length = 0;
    clock.advance(599_000);
    // tool_execution_update is now dual-purpose: gate (activity) + outbound frame.
    pi.emit("tool_execution_update", {
      type: "tool_execution_update",
      toolName: "bash",
      details: { n: 1 },
    });
    expect(broadcaster.frames).toContainEqual({
      type: "tool_execution_update",
      toolName: "bash",
      details: { n: 1 },
    });
    clock.advance(1_000);
    const forceReleases = broadcaster.frames.filter((f) => f.type === "mutex_force_release");
    expect(forceReleases).toHaveLength(0);
  });

  test("agent_settled BOTH releases the mutex AND broadcasts a frame", () => {
    const { pi, broadcaster } = setup();
    const gate = pi.handlersFor("input")[0];
    // web acquires the lock.
    gate({ type: "input", source: "extension", text: "x" }, pi.ctx);
    broadcaster.frames.length = 0;
    // Emit agent_settled → handleSettled releases + broadcast handler forwards.
    pi.emit("agent_settled", { type: "agent_settled" });
    expect(broadcaster.frames).toContainEqual({ type: "agent_settled" });
    // Release effect: after settle, a TUI input can now acquire (web no longer
    // driving). Were handleSettled unwired, this would be {action:"handled"}.
    const tui = gate({ type: "input", source: "interactive", text: "tui" }, pi.ctx);
    expect(tui).toEqual({ action: "continue" });
  });
});

describe("wireWebui — lifecycle", () => {
  test("session_start starts the server + binds the session", () => {
    const { pi, server } = setup();
    expect(server.hasSession()).toBe(false);
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    expect(server.startCalls).toBe(1);
    expect(server.bindCalls).toBe(1);
    expect(server.hasSession()).toBe(true);
  });

  test("session_shutdown drops the session but does NOT stop the server", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(server.dropCalls).toBe(1);
    expect(server.hasSession()).toBe(false);
    expect(server.stopCalls).toBe(0); // server survives (persistent co-frontend)
  });

  test("announce fires on the first render (not at session_start) — fire-once", () => {
    const { pi } = setup();
    // session_start alone must NOT announce (deferred to first content).
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    expect(pi.ctx.notifications).toEqual([]);
    expect(pi.ctx.statuses).toEqual([]);
    // first render triggers the announce. The webui:render event is the
    // producer the wiring registers (pi.events.on) — it flows through the
    // render-event-handler into registry.render(), which fires subscribers.
    pi.events.emit("webui:render", { content: "# first" });
    // FakeWebServer.url is "http://fake.local/".
    expect(pi.ctx.notifications).toEqual([
      { message: "webui ready — open http://fake.local/ in a browser to view rendered results and send feedback. (loopback · no auth)", type: "info" },
    ]);
    expect(pi.ctx.statuses).toEqual([
      { key: "webui", text: "🌐 webui · http://fake.local/ · open in browser to view results" },
    ]);
    // one-shot: a second render must NOT re-announce.
    pi.events.emit("webui:render", { content: "# second" });
    expect(pi.ctx.notifications).toHaveLength(1);
    expect(pi.ctx.statuses).toHaveLength(1);
  });
});

describe("wireWebui — inbound dispatch", () => {
  test("agentic prompt → pi.sendUserMessage(text) delivered", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    dispatch(pi, server, { type: "prompt", text: "hello web" });
    expect(pi.sent).toEqual([{ content: "hello web", opts: undefined }]);
  });

  test("agentic steer → sendUserMessage(text,{deliverAs:'steer'})", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    dispatch(pi, server, { type: "steer", text: "nudge" });
    expect(pi.sent).toEqual([{ content: "nudge", opts: { deliverAs: "steer" } }]);
  });

  test("agentic followUp → sendUserMessage(text,{deliverAs:'followUp'})", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    dispatch(pi, server, { type: "followUp", text: "more" });
    expect(pi.sent).toEqual([{ content: "more", opts: { deliverAs: "followUp" } }]);
  });

  test("agentic abort → ctx.abort() recorded (no message)", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    dispatch(pi, server, { type: "abort" });
    expect(pi.ctx.abortCalls).toBe(1);
    expect(pi.sent).toHaveLength(0);
  });

  describe("HITL appexec return transport (respond resolve + registry + abort)", () => {
    test("respond resolves the pending registered under id with {action}", async () => {
      const { pi, server, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const pending = wiring.registerPending("p1");
      dispatch(pi, server, { type: "appexec", extra: { kind: "respond", id: "p1", action: "approve" } });
      await expect(pending).resolves.toEqual({ action: "approve" });
    });

    test("respond with tweak surfaces tweak", async () => {
      const { pi, server, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const pending = wiring.registerPending("p2");
      dispatch(pi, server, {
        type: "appexec",
        extra: { kind: "respond", id: "p2", action: "regenerate", tweak: "more red" },
      });
      await expect(pending).resolves.toEqual({ action: "regenerate", tweak: "more red" });
    });

    test("respond for an unknown id is ignored (the registered pending stays pending)", async () => {
      const { pi, server, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const p3 = wiring.registerPending("p3");
      // A respond for a DIFFERENT id must NOT resolve p3.
      dispatch(pi, server, { type: "appexec", extra: { kind: "respond", id: "nope", action: "approve" } });
      let resolved = false;
      p3.then(() => { resolved = true; });
      await Promise.resolve(); // drain microtasks — resolve() is synchronous, so this is enough.
      expect(resolved).toBe(false);
      // Clean up the dangling pending via abort (also re-asserts session_shutdown cancels).
      pi.emit("session_shutdown", { type: "session_shutdown", reason: "done" });
      await expect(p3).resolves.toEqual({ cancelled: true });
    });

    test("session_shutdown resolves all pending as {cancelled:true}", async () => {
      const { pi, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const a = wiring.registerPending("a");
      const b = wiring.registerPending("b");
      pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await expect(a).resolves.toEqual({ cancelled: true });
      await expect(b).resolves.toEqual({ cancelled: true });
    });

    test("WS close resolves all pending as {cancelled:true}", async () => {
      const { pi, server, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const pending = wiring.registerPending("ws1");
      // wireWebui registered the close handler on the fake server.
      expect(server.wsCloseHandler).not.toBeNull();
      server.wsCloseHandler!();
      await expect(pending).resolves.toEqual({ cancelled: true });
    });

    test("registerPending resolves a stale DUPLICATE id as {cancelled:true} (no silent overwrite)", async () => {
      const { pi, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const first = wiring.registerPending("dup");
      const second = wiring.registerPending("dup");
      // The FIRST registration must not hang forever — it resolves as cancelled.
      await expect(first).resolves.toEqual({ cancelled: true });
      // The second registration stays pending (it now owns the id).
      let resolved = false;
      second.then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false);
      // Clean up + re-assert session_shutdown cancels the surviving registration.
      pi.emit("session_shutdown", { type: "session_shutdown", reason: "done" });
      await expect(second).resolves.toEqual({ cancelled: true });
    });
  });

  test("control subscribe/unsubscribe → no side effect (v1 no-op)", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    dispatch(pi, server, { type: "subscribe" });
    dispatch(pi, server, { type: "unsubscribe" });
    expect(pi.sent).toHaveLength(0);
    expect(pi.ctx.abortCalls).toBe(0);
  });
});

describe("wireWebui — NO-SESSION guard", () => {
  test("before session_start: agentic command → no_session reply, no deref, no crash", () => {
    const { pi, server } = setup();
    expect(server.hasSession()).toBe(false);
    const replies = dispatch(pi, server, { type: "prompt", text: "early" });
    expect(pi.sent).toHaveLength(0); // never derefs a null session
    expect(replies).toEqual([{ type: "error", reason: "no_session" }]);
  });
});

describe("wireWebui — block feedback is broadcast (no ack)", () => {
  test("web command while 'tui' driving: swallowed + mutex_blocked broadcast, NO ack", () => {
    const { pi, server, broadcaster } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    // tui acquires the lock via the input gate
    const gate = pi.handlersFor("input")[0];
    gate({ type: "input", source: "interactive", text: "tui owns" }, pi.ctx);
    broadcaster.frames.length = 0;

    const replies = dispatch(pi, server, { type: "prompt", text: "web tries" });
    // The web command is swallowed (sendUserMessage suppresses on "handled").
    expect(pi.sent).toHaveLength(0);
    // A mutex_blocked frame IS broadcast.
    expect(broadcaster.frames).toContainEqual({
      type: "mutex_blocked",
      blocked: "web",
      by: "tui",
    });
    // NO per-command ack frame of any kind.
    expect(broadcaster.frames.every((f) => f.type !== "ack")).toBe(true);
    expect(replies).toHaveLength(0); // no reply either (block feedback is broadcast-only)
  });
});

describe("wireWebui — dispose()", () => {
  test("neutralizes handlers + stops the server + clears the command handler", () => {
    const { pi, server, broadcaster, wiring } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    // Capture the handler BEFORE dispose (dispose nulls it).
    const handler = server.commandHandler!;
    wiring.dispose();
    expect(server.stopCalls).toBe(1);
    expect(server.commandHandler).toBeNull();
    // After dispose, firing an outbound event broadcasts nothing.
    const before = broadcaster.frames.length;
    pi.emit("tool_execution_end", { type: "tool_execution_end", toolName: "bash" });
    expect(broadcaster.frames.length).toBe(before);
    // After dispose, invoking the (now-disposed) inbound handler is a no-op.
    handler({ type: "prompt", text: "post" }, () => {});
    expect(pi.sent).toHaveLength(0);
    // And idempotent: a second dispose does not re-stop the server.
    wiring.dispose();
    expect(server.stopCalls).toBe(1);
  });
});

/**
 * The ONE test that legitimately uses the REAL WebServer (ephemeral port 0) —
 * the Path-A keystone invariant: the module-level WebServer singleton
 * (webui-wiring.ts `singletonServer`) is module-cached, so it survives the
 * per-session factory re-run. Two `wireWebui()` calls with NO injected server
 * MUST reuse the SAME live transport (not spin up a second Bun.serve).
 *
 * The singleton is module-private, so a `start()` prototype spy captures the
 * live instance for identity + idempotent-reuse assertions. Proper teardown
 * (dispose → stop) in afterEach so no bound port leaks across the run.
 */
describe("wireWebui — webui:present event (present-as-view, spec Decision A)", () => {
  test("a webui:present payload mints the 'present' view carrying controls + presentId", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    pi.events.emit("webui:present", {
      content: "# pick one",
      id: "p9",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
    });
    // Observe the minted view through the installed HTTP routes (the registry
    // is wiring-internal; httpRoutes closes over it).
    expect(server.httpRoutes).not.toBeNull();
    const res = server.httpRoutes!(new Request("http://t/api/view/present"), {} as never);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "present",
      mode: "md",
      presentId: "p9",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
    });
    expect(body.html).toContain("<h1");
  });

  test("an invalid webui:present payload mints nothing (no throw)", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    expect(() => pi.events.emit("webui:present", { content: "no controls" })).not.toThrow();
    const res = server.httpRoutes!(new Request("http://t/api/view/present"), {} as never);
    expect(res.status).toBe(404);
  });
});

describe("wireWebui — webui_present blocking gate (integration via MockPi)", () => {
  function presentToolOf(pi: MockPi): any {
    const tool = pi.registeredTools.find((t: any) => t?.name === "webui_present");
    expect(tool).toBeDefined();
    return tool;
  }

  test("present → view minted with controls; respond → execute resolves {action, tweak}", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    const tool = presentToolOf(pi);
    const blocked = tool.execute(
      "c1",
      {
        content: "![image](/output/0/img.png)",
        controls: [
          { id: "approve", label: "Approve" },
          { id: "regenerate", label: "Regenerate…", takesInput: true },
        ],
      },
      undefined, undefined, {} as never
    );
    // The present path minted the DEFAULT 'present' view (webui:present event →
    // handler → registry); observe it via the installed HTTP routes.
    expect(server.httpRoutes).not.toBeNull();
    const res = server.httpRoutes!(new Request("http://t/api/view/present"), {} as never);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "present",
      mode: "md",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
    });
    // The generated presentId is discoverable from the view — use it to respond.
    dispatch(pi, server, {
      type: "appexec",
      extra: { kind: "respond", id: body.presentId, action: "regenerate", tweak: "more red" },
    });
    const out = await blocked;
    expect(out.content[0].text).toBe('User requested regenerate with tweak: "more red".');
    expect(out.details).toEqual({ action: "regenerate", tweak: "more red" });
  });

  test("a SECOND webui_present while one pending → error result", async () => {
    const { pi } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    const tool = presentToolOf(pi);
    const first = tool.execute(
      "c1", { content: "a", controls: [{ id: "approve", label: "Approve" }] },
      undefined, undefined, {} as never
    );
    const second = await tool.execute(
      "c2", { content: "b", controls: [{ id: "approve", label: "Approve" }] },
      undefined, undefined, {} as never
    );
    expect(second.details).toEqual({ error: "already_pending" });
    expect(second.content[0].text).toContain("already pending");
    // The first presentation survives and still resolves on shutdown.
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    const out = await first;
    expect(out.details).toEqual({ cancelled: true });
    expect(out.content[0].text).toBe("User cancelled / connection lost.");
  });

  test("session_shutdown mid-pending → execute resolves {cancelled:true}", async () => {
    const { pi } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    const tool = presentToolOf(pi);
    const blocked = tool.execute(
      "c1", { content: "a", controls: [{ id: "approve", label: "Approve" }] },
      undefined, undefined, {} as never
    );
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    const out = await blocked;
    expect(out.details).toEqual({ cancelled: true });
    expect(out.content[0].text).toBe("User cancelled / connection lost.");
  });
});

describe("wireWebui — persistent-co-frontend singleton (Path-A keystone)", () => {
  let wirings: WebuiWiring[] = [];
  let instances: WebServer[] = [];
  let originalStart: typeof WebServer.prototype.start | undefined;

  beforeEach(() => {
    instances = [];
    wirings = [];
    originalStart = WebServer.prototype.start;
    WebServer.prototype.start = function (this: WebServer) {
      instances.push(this);
      return originalStart!.call(this);
    };
  });
  afterEach(() => {
    if (originalStart) WebServer.prototype.start = originalStart;
    for (const w of wirings) {
      try {
        w.dispose();
      } catch {
        /* idempotent teardown */
      }
    }
    wirings = [];
  });

  test("two wireWebui() calls with NO injected server reuse the SAME WebServer singleton", () => {
    const pi1 = new MockPi();
    const w1 = wireWebui(pi1); // no `server` injected → module singleton
    wirings.push(w1);
    pi1.emit("session_start", { type: "session_start", reason: "startup" });
    expect(instances).toHaveLength(1); // first session_start served exactly once
    const port1 = instances[0].port;
    expect(port1).toBeGreaterThan(0); // OS-assigned ephemeral, not the literal 0

    const pi2 = new MockPi();
    const w2 = wireWebui(pi2); // MUST reuse the cached singleton, not a new server
    wirings.push(w2);
    pi2.emit("session_start", { type: "session_start", reason: "startup" });

    // Keystone: the SAME WebServer instance backs both factory runs
    // (module-cached → survives the per-session factory re-run).
    expect(instances.every((s) => s === instances[0])).toBe(true);
    // start() is idempotent on a live server → the bound port is unchanged
    // (no second Bun.serve bound a different port).
    expect(instances[0].port).toBe(port1);
  });
});

describe("wireWebui — optionality gate (architecture v2 §3.1)", () => {
  test("enabled:false registers NO pi.on handlers and NO tools", () => {
    const pi = new MockPi();
    const wiring = wireWebui(pi, { enabled: false });
    expect(pi.registeredEvents()).toEqual([]);
    expect(pi.registeredTools).toEqual([]);
    expect(wiring.dispose).toBeTypeOf("function");
  });

  test("enabled:false → session_start never touches the server (deps.server ignored)", () => {
    const pi = new MockPi();
    const server = new FakeWebServer();
    wireWebui(pi, { enabled: false, server });
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    expect(server.startCalls).toBe(0);
    expect(server.hasSession()).toBe(false);
    expect(pi.handlersFor("session_start")).toEqual([]);
  });

  test("enabled:false → registerPending resolves {cancelled:true} immediately", async () => {
    const pi = new MockPi();
    const wiring = wireWebui(pi, { enabled: false });
    await expect(wiring.registerPending("x")).resolves.toEqual({ cancelled: true });
  });

  test("enabled:false → dispose() is a no-op and repeatable", () => {
    const pi = new MockPi();
    const wiring = wireWebui(pi, { enabled: false });
    expect(() => wiring.dispose()).not.toThrow();
    expect(() => wiring.dispose()).not.toThrow();
  });

  test("WEBUI_DISABLED=1 env disables the wiring (no deps.enabled)", () => {
    const prev = process.env.WEBUI_DISABLED;
    process.env.WEBUI_DISABLED = "1";
    try {
      const pi = new MockPi();
      const wiring = wireWebui(pi);
      expect(pi.registeredEvents()).toEqual([]);
      expect(wiring.dispose).toBeTypeOf("function");
    } finally {
      if (prev === undefined) delete process.env.WEBUI_DISABLED;
      else process.env.WEBUI_DISABLED = prev;
    }
  });
});

describe("wireWebui — v2 session store + snapshot (architecture v2 §3.3)", () => {
  test("outbound frames accumulate in the store; wsOpenHandler pushes a snapshot to THAT client", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    // Drive two outbound events through the wiring's broadcast path.
    pi.emit("turn_start", { type: "turn_start" });
    pi.emit("message_update", { type: "message_update", text: "hi" });
    expect(server.wsOpenHandler).not.toBeNull();
    const sent: string[] = [];
    server.wsOpenHandler!({ send: (s: string) => sent.push(s) } as never);
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]);
    expect(frame.type).toBe("snapshot");
    expect(frame.state.transcript.map((f: { type: string }) => f.type)).toEqual([
      "turn_start",
      "message_update",
    ]);
    expect(frame.state.presentId).toBeNull();
    expect(frame.state.driver).toBeNull();
  });

  test("session_shutdown clears the store; a later snapshot is empty (server survives)", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    pi.emit("turn_start", { type: "turn_start" });
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    const sent: string[] = [];
    server.wsOpenHandler!({ send: (s: string) => sent.push(s) } as never);
    expect(JSON.parse(sent[0]).state.transcript).toEqual([]);
  });
});

describe("wireWebui — v2 mutex/present fixes (architecture v2 §3.5)", () => {
  test("session_start resets a stale mutex driver (per-session lock)", () => {
    const { pi, broadcaster } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    pi.emit("input", { type: "input", source: "extension" }); // web acquires
    // A NEW session_start must release the stale lock: a TUI input now
    // continues (no mutex_blocked) instead of being suppressed.
    pi.emit("session_start", { type: "session_start", reason: "resume" });
    pi.emit("input", { type: "input", source: "interactive" });
    expect(broadcaster.frames.filter((f) => f.type === "mutex_blocked")).toEqual([]);
  });

  test("a blocked INTERACTIVE input notifies the TUI user via ctx.ui (feedback reaches the TUI)", () => {
    const { pi } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    pi.emit("input", { type: "input", source: "extension" }); // web acquires
    pi.emit("input", { type: "input", source: "interactive" }); // tui blocked
    expect(
      pi.ctx.notifications.some((n) => n.type === "warning" && n.message.includes("blocked"))
    ).toBe(true);
    // A web-side block does NOT spam the TUI user (they are not the blocker).
    pi.emit("input", { type: "input", source: "interactive" }); // tui now drives
    const before = pi.ctx.notifications.length;
    pi.emit("input", { type: "input", source: "extension" }); // web blocked
    expect(pi.ctx.notifications.length).toBe(before);
  });

  test("appexec cancel resolves the ONE pending under id as {cancelled:true}", async () => {
    const { pi, server, wiring } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    const p = wiring.registerPending("pres-1");
    const replies = dispatch(pi, server, { type: "appexec", extra: { kind: "cancel", id: "pres-1" } });
    expect(replies).toEqual([]); // no reply frame on the cancel path
    await expect(p).resolves.toEqual({ cancelled: true });
  });

  test("the watchdog is SUSPENDED while a presentation is pending (no force-release under HITL)", () => {
    const { pi, broadcaster, clock, server, wiring } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    pi.emit("input", { type: "input", source: "extension" }); // web drives (watchdog armed)
    void wiring.registerPending("p1");
    clock.advance(11 * 60_000); // way past the 10-min stale — suspended, no release
    expect(broadcaster.frames.filter((f) => f.type === "mutex_force_release")).toEqual([]);
    // Resolve the pending -> watchdog resumes -> the stale turn force-releases.
    dispatch(pi, server, { type: "appexec", extra: { kind: "cancel", id: "p1" } });
    clock.advance(11 * 60_000);
    expect(broadcaster.frames.filter((f) => f.type === "mutex_force_release")).toHaveLength(1);
  });

  test("a render BEFORE session_start does not burn the announce latch (v2)", () => {
    const { pi } = setup();
    // Render fires before any session_start: no bound ctx -> no announce, and
    // the latch stays OPEN (v1 set it before the ui guard, permanently
    // suppressing the announce).
    pi.events.emit("webui:render", { content: "# pre" });
    expect(pi.ctx.notifications).toHaveLength(0);
    // session_start binds; the NEXT render announces the resolved URL.
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    pi.events.emit("webui:render", { content: "# post" });
    expect(pi.ctx.notifications.some((n) => n.message.includes("webui ready"))).toBe(true);
    expect(pi.ctx.statuses.some((s) => s.key === "webui")).toBe(true);
  });
});

describe("wireWebui — images → /output markdown wiring (render-review F3)", () => {
  test("webui:render with images appends ![image](/output/0/...) via deps.outputDir", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "webui-f3-"));
    const outDir = path.join(tmpRoot, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "shot.png"), "PNG");
    try {
      const pi = new MockPi();
      const server = new FakeWebServer();
      wireWebui(pi, { broadcaster: new MemoryBroadcaster(), clock: new FakeClock(), server, outputDir: outDir });
      pi.events.emit("webui:render", {
        content: "# generated",
        images: [path.join(outDir, "shot.png")],
      });
      // The view's md content must now carry the image markdown; served through
      // the httpRoutes seam (render route) as rendered HTML.
      const handler = server.httpRoutes!;
      const res = handler(new Request("http://t/api/view/main"), undefined as never);
      expect(res).not.toBeNull();
      const body = await res!.json();
      expect(body.html).toContain('src="/output/0/shot.png"');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("webui:present with images appends the markdown to the present view", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "webui-f3b-"));
    const outDir = path.join(tmpRoot, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "face.png"), "PNG");
    try {
      const pi = new MockPi();
      const server = new FakeWebServer();
      wireWebui(pi, { broadcaster: new MemoryBroadcaster(), clock: new FakeClock(), server, outputDir: outDir });
      pi.events.emit("webui:present", {
        content: "# approve?",
        controls: [{ id: "approve", label: "Approve" }],
        id: "present_1",
        images: [path.join(outDir, "face.png")],
      });
      const handler = server.httpRoutes!;
      const res = handler(new Request("http://t/api/view/present"), undefined as never);
      const body = await res!.json();
      expect(body.html).toContain('src="/output/0/face.png"');
      expect(body.presentId).toBe("present_1");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("an image OUTSIDE the output dir is skipped (imageMd containment), not appended", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "webui-f3c-"));
    const outDir = path.join(tmpRoot, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(tmpRoot, "secret.png"), "PNG"); // OUTSIDE outDir
    try {
      const pi = new MockPi();
      const server = new FakeWebServer();
      wireWebui(pi, { broadcaster: new MemoryBroadcaster(), clock: new FakeClock(), server, outputDir: outDir });
      pi.events.emit("webui:render", {
        content: "# x",
        images: [path.join(tmpRoot, "secret.png")],
      });
      const handler = server.httpRoutes!;
      const res = handler(new Request("http://t/api/view/main"), undefined as never);
      const body = await res!.json();
      expect(body.html).not.toContain("secret.png");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
