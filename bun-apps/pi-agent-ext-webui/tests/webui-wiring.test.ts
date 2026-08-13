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

  test("appexec → NO sendUserMessage, NO lock acquired", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    dispatch(pi, server, { type: "appexec" });
    expect(pi.sent).toHaveLength(0);
    // No input event fired (appexec bypasses the gate) → controller stays idle.
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
