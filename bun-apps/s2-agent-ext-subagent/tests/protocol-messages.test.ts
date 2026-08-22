/**
 * Protocol-message layer (agent-teams parity ticket 04,
 * effort .planning/2026-08-22-subagent-teams-parity).
 *
 * Pins the four send_message type envelopes + the child-injected
 * request_plan_approval tool against fakes: the plan-approval
 * approve/deny/timeout matrix (D6 default-deny), the two-stage shutdown
 * (wrap-up → grace → release, ONE abort lever per exchange), child→parent
 * notification-only semantics, detached-resume refusal, stop-by-name, and the
 * named-dispatch allowlist append that carries request_plan_approval into a
 * child's toolset.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyToolPolicy,
  type LiveAgentHandle,
  type LiveAgentRegistry,
  LiveAgentRegistry as LiveAgentRegistryClass,
  type LiveAgentSendResult,
  PendingProtocolMap,
} from "@repo/s2-agent-core-runtime";
import { ParentMessageBus } from "../src/parent-message-bus.js";
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  isDetachedResumeHost,
  SHUTDOWN_WRAP_UP_MESSAGE,
  SUBAGENT_DETACHED_RESUME_ENV,
} from "../src/protocol-format.js";
import { createRequestPlanApprovalTool, REQUEST_PLAN_APPROVAL_TOOL_NAME } from "../src/request-plan-approval-tool.js";
import { createSendMessageTool } from "../src/send-message-tool.js";
import { createSubagentRunsTool } from "../src/subagent-runs-tool.js";
import { buildSpawnOptions } from "../src/subagent-tool-run.js";

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeState {
  sends: Array<{ text: string; opts?: { timeoutMs?: number; label?: string } }>;
  status: "running" | "idle";
  disposed: number;
}

/** Controllable LiveAgentHandle double — send() returns scripted results per call. */
function fakeAgent(script: Array<LiveAgentSendResult | Error> = [], status: "running" | "idle" = "idle") {
  const state: FakeState = { sends: [], status, disposed: 0 };
  let i = 0;
  const agent: LiveAgentHandle = {
    get status() {
      return state.status;
    },
    async send(text, opts) {
      state.sends.push({ text, opts });
      const next = script[i++] ?? { output: `ack: ${text}` };
      if (next instanceof Error) throw next;
      return next;
    },
    touch: () => {},
    dispose: () => state.disposed++,
  };
  return { agent, state };
}

function mkTool(env?: Record<string, string | undefined>) {
  const liveRegistry: LiveAgentRegistry = new LiveAgentRegistryClass(4);
  const bus = new ParentMessageBus();
  const pending = new PendingProtocolMap();
  const delivered: string[] = [];
  bus.setDeliverer((msg) => delivered.push(msg));
  const tool = createSendMessageTool({
    liveRegistry,
    bus,
    pending,
    background: { deliver: () => {} },
    env,
  });
  return { tool, liveRegistry, bus, pending, delivered };
}

const text = (r: { content: Array<{ type: string; text: string }> }) => r.content[0]?.text ?? "";

// ── request_plan_approval: the approve/deny/timeout matrix ──────────────────

function mkChildTool(pending: PendingProtocolMap, bus: ParentMessageBus, env?: Record<string, string | undefined>) {
  return createRequestPlanApprovalTool({ bus, pending, env });
}

test("plan approval: parent approve resolves the held promise", async () => {
  const { tool, liveRegistry, bus, pending } = mkTool();
  liveRegistry.register({ name: "researcher", agentId: "c1", agent: fakeAgent().agent, cwd: "/repo" });
  const child = mkChildTool(pending, bus);
  const held = child.execute("t1", { plan: "do A then B", from: "researcher" }, NO_SIGNAL, undefined, NO_CTX);
  await sleep(5);
  const res = await tool.execute(
    "t2",
    { to: "researcher", message: "", type: "plan_approval_response", approve: true, feedback: "skip B" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /APPROVED/);
  assert.match(text(await held), /APPROVED.*skip B/s);
  assert.equal(pending.size, 0);
});

test("plan approval: parent deny (explicit) carries feedback, no timedOut flag wording", async () => {
  const { tool, liveRegistry, bus, pending } = mkTool();
  liveRegistry.register({ name: "researcher", agentId: "c1", agent: fakeAgent().agent, cwd: "/repo" });
  const child = mkChildTool(pending, bus);
  const held = child.execute(
    "t1",
    { plan: "rewrite main.py wholesale", from: "researcher" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  await sleep(5);
  await tool.execute(
    "t2",
    { to: "researcher", message: "", type: "plan_approval_response", approve: false, feedback: "too broad" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const out = text(await held);
  assert.match(out, /DENIED/);
  assert.match(out, /too broad/);
  assert.doesNotMatch(out, /TIMED OUT/);
});

test("plan approval: timeout defaults to DENY (D6)", async () => {
  const { bus, pending } = mkTool();
  const child = mkChildTool(pending, bus);
  const out = text(
    await child.execute("t1", { plan: "p", from: "researcher", timeoutMs: 20 }, NO_SIGNAL, undefined, NO_CTX),
  );
  assert.match(out, /TIMED OUT/);
  assert.match(out, /DENIED by default/);
  assert.equal(pending.size, 0);
});

test("plan approval: bus failure surfaces the actionable error and holds nothing", async () => {
  const bus = new ParentMessageBus(); // no deliverer wired
  const pending = new PendingProtocolMap();
  const child = mkChildTool(pending, bus);
  const out = text(await child.execute("t1", { plan: "p", from: "researcher" }, NO_SIGNAL, undefined, NO_CTX));
  assert.match(out, /unavailable/);
  assert.equal(pending.size, 0);
});

// ── plan_approval_response validation ───────────────────────────────────────

test("plan_approval_response without an explicit verdict is refused", async () => {
  const { tool, liveRegistry } = mkTool();
  liveRegistry.register({ name: "researcher", agentId: "c1", agent: fakeAgent().agent, cwd: "/repo" });
  const res = await tool.execute(
    "t1",
    { to: "researcher", message: "", type: "plan_approval_response" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /approve: true\|false/);
});

test("plan_approval_response to 'main' is a direction error", async () => {
  const { tool } = mkTool();
  const res = await tool.execute(
    "t1",
    { to: "main", message: "", type: "plan_approval_response", approve: true },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /addresses the AGENT/);
});

test("plan_approval_response with no pending hold lists the pending names", async () => {
  const { tool, liveRegistry } = mkTool();
  liveRegistry.register({ name: "researcher", agentId: "c1", agent: fakeAgent().agent, cwd: "/repo" });
  const res = await tool.execute(
    "t1",
    { to: "researcher", message: "", type: "plan_approval_response", approve: true },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /No pending plan approval/);
});

test("plan_approval_response resolves by agentId through the registry key", async () => {
  const { tool, liveRegistry, bus, pending } = mkTool();
  liveRegistry.register({ name: "researcher", agentId: "c-by-id", agent: fakeAgent().agent, cwd: "/repo" });
  const child = mkChildTool(pending, bus);
  const held = child.execute("t1", { plan: "p", from: "researcher", timeoutMs: 5000 }, NO_SIGNAL, undefined, NO_CTX);
  await sleep(5);
  await tool.execute(
    "t2",
    { to: "c-by-id", message: "", type: "plan_approval_response", approve: true },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(await held), /APPROVED/);
});

// ── shutdown_request: parent→child two-stage ────────────────────────────────

test("shutdown_request (idle agent): wrap-up exchange runs, then the agent is released", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent, state } = fakeAgent([{ output: "state saved to /tmp/x.md" }]);
  liveRegistry.register({ name: "worker", agentId: "c1", agent, cwd: "/repo" });
  const res = await tool.execute(
    "t1",
    { to: "worker", message: "wrapping up", type: "shutdown_request" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(state.sends.length, 1);
  assert.match(state.sends[0]?.text ?? "", /FINAL turn/);
  assert.equal(state.sends[0]?.opts?.label, "shutdown");
  assert.match(text(res), /wrapped up and is stopped/);
  assert.match(text(res), /state saved/);
  assert.equal(liveRegistry.get("worker"), undefined); // off the roster
  assert.equal(state.disposed, 1); // exactly one dispose — one abort lever
});

test("shutdown_request (mid-flight agent): steer returns immediately; the grace timer stops it later", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent, state } = fakeAgent([{ output: "", steered: true }], "running");
  liveRegistry.register({ name: "worker", agentId: "c1", agent, cwd: "/repo" });
  const res = await tool.execute(
    "t1",
    { to: "worker", message: "", type: "shutdown_request", timeoutMs: 30 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /steered into its current exchange/);
  assert.match(text(res), /grace/);
  assert.equal(state.disposed, 0); // NOT stopped while the exchange runs
  assert.ok(liveRegistry.get("worker")); // still on the roster under grace
  await sleep(60);
  assert.equal(state.disposed, 1); // grace fired — exactly one stop
  assert.equal(liveRegistry.get("worker"), undefined);
});

test("shutdown_request: wrap-up failure still stops the agent (release is unconditional)", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent, state } = fakeAgent([new Error("model exploded")]);
  liveRegistry.register({ name: "worker", agentId: "c1", agent, cwd: "/repo" });
  const res = await tool.execute(
    "t1",
    { to: "worker", message: "", type: "shutdown_request", timeoutMs: 50 },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /stopped/);
  assert.equal(liveRegistry.get("worker"), undefined);
  assert.equal(state.disposed, 1);
});

test("shutdown_request: unknown agent names the roster", async () => {
  const { tool } = mkTool();
  const res = await tool.execute(
    "t1",
    { to: "ghost", message: "", type: "shutdown_request" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /No live agent "ghost"/);
});

test("SHUTDOWN_WRAP_UP_MESSAGE mirrors the budget guard's two-stage shape", () => {
  assert.match(SHUTDOWN_WRAP_UP_MESSAGE, /FINAL turn/);
  assert.match(SHUTDOWN_WRAP_UP_MESSAGE, /Write your current findings/);
  assert.equal(DEFAULT_SHUTDOWN_GRACE_MS, 60_000);
});

// ── shutdown_request / notifications: child→parent ──────────────────────────

test("child shutdown_request to 'main' is notification-only (the parent approves by stopping)", async () => {
  const { tool, delivered } = mkTool();
  const res = await tool.execute(
    "t1",
    { to: "main", message: "I am done; findings at /tmp/out.md", type: "shutdown_request", from: "researcher" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /notification only/);
  assert.match(text(res), /approves by stopping/);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0] ?? "", /<shutdown-request>/);
  assert.match(delivered[0] ?? "", /action: 'stop'/);
});

test("child plan_approval_request to 'main' notifies and names the response envelope", async () => {
  const { tool, delivered } = mkTool();
  const res = await tool.execute(
    "t1",
    { to: "main", message: "1) read code 2) patch", type: "plan_approval_request", from: "researcher" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /plan_approval_response/);
  assert.match(delivered[0] ?? "", /<plan-approval-request>/);
  assert.match(delivered[0] ?? "", /"researcher"/);
});

test("plan_approval_request parent→child is refused (child→parent only)", async () => {
  const { tool, liveRegistry } = mkTool();
  liveRegistry.register({ name: "worker", agentId: "c1", agent: fakeAgent().agent, cwd: "/repo" });
  const res = await tool.execute(
    "t1",
    { to: "worker", message: "plan?", type: "plan_approval_request" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /child→parent only/);
});

test("shutdown_response acknowledges in both directions", async () => {
  const { tool, liveRegistry, delivered } = mkTool();
  const resMain = await tool.execute(
    "t1",
    { to: "main", message: "done, saved", type: "shutdown_response", from: "researcher" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(resMain), /acknowledgment delivered/);
  assert.match(delivered[0] ?? "", /shutdown_response/);
  const { agent } = fakeAgent([{ output: "ok" }]);
  liveRegistry.register({ name: "worker", agentId: "c1", agent, cwd: "/repo" });
  const resAgent = await tool.execute(
    "t2",
    { to: "worker", message: "thanks, goodbye", type: "shutdown_response" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(resAgent), /ok/);
});

// ── detached-resume refusal (in-process only, per spec) ─────────────────────

const DETACHED_ENV = { [SUBAGENT_DETACHED_RESUME_ENV]: "run-detached-1" };

test("isDetachedResumeHost keys off the env marker", () => {
  assert.equal(isDetachedResumeHost({}), false);
  assert.equal(isDetachedResumeHost(DETACHED_ENV), true);
});

test("detached child: child-origin protocol messages to 'main' refuse with a clear error", async () => {
  const { tool } = mkTool(DETACHED_ENV);
  for (const type of ["shutdown_request", "plan_approval_request", "shutdown_response"] as const) {
    const res = await tool.execute(
      "t1",
      { to: "main", message: "m", type, from: "researcher" },
      NO_SIGNAL,
      undefined,
      NO_CTX,
    );
    assert.match(text(res), /detached resume subprocess/);
  }
});

test("detached child: request_plan_approval refuses", async () => {
  const bus = new ParentMessageBus();
  bus.setDeliverer(() => {}); // wired — refusal must come from the env marker, not the bus
  const child = createRequestPlanApprovalTool({ bus, pending: new PendingProtocolMap(), env: DETACHED_ENV });
  const out = text(await child.execute("t1", { plan: "p", from: "researcher" }, NO_SIGNAL, undefined, NO_CTX));
  assert.match(out, /detached resume subprocess/);
});

// ── stop-by-name on list_subagent_runs ──────────────────────────────────────

test("stop by live-agent name: parked agent is released off the roster", async () => {
  const { liveRegistry } = mkTool();
  const { agent, state } = fakeAgent();
  liveRegistry.register({ name: "researcher", agentId: "call-r", agent, cwd: "/repo" });
  const inFlight = {
    view: () => undefined, // parked between exchanges — no in-flight entry
    abort: () => {
      throw new Error("no in-flight entry to abort");
    },
  } as never;
  const persistence = { list: () => [], load: () => undefined } as never;
  const runs = createSubagentRunsTool({ persistence, inFlight, liveRegistry });
  const res = await runs.execute("t1", { action: "stop", id: "researcher" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /stopped live agent "researcher"/);
  assert.equal(state.disposed, 1);
  assert.equal(liveRegistry.get("researcher"), undefined);
});

test("stop by live-agent name: mid-FIRST-exchange aborts the run instead", async () => {
  const { tool: _tool, liveRegistry } = mkTool();
  void _tool;
  const { agent } = fakeAgent([], "running");
  liveRegistry.register({ name: "researcher", agentId: "call-r", agent, cwd: "/repo" });
  const aborted: string[] = [];
  const inFlight = {
    view: (id: string) => (id === "call-r" ? { status: "running" } : undefined),
    abort: (id: string) => aborted.push(id),
  } as never;
  const persistence = { list: () => [], load: () => undefined } as never;
  const runs = createSubagentRunsTool({ persistence, inFlight, liveRegistry });
  const res = await runs.execute("t1", { action: "stop", id: "researcher" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /first-exchange run call-r/);
  assert.deepEqual(aborted, ["call-r"]);
});

test("stop by unknown name still reports the unknown-run error", async () => {
  const { tool: _tool, liveRegistry } = mkTool();
  void _tool;
  const inFlight = { view: () => undefined, abort: () => {} } as never;
  const persistence = { list: () => [], load: () => undefined } as never;
  const runs = createSubagentRunsTool({ persistence, inFlight, liveRegistry });
  const res = await runs.execute("t1", { action: "stop", id: "ghost" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /unknown run "ghost"/);
});

// ── named-dispatch allowlist append ─────────────────────────────────────────

function spawnOptsFor(params: Record<string, unknown>) {
  const savedHints = process.env.PI_SUBAGENT_HINTS_FILE;
  process.env.PI_SUBAGENT_HINTS_FILE = "/nonexistent/pi-subagent-hints-absent.fixture.md";
  try {
    return buildSpawnOptions(
      {
        toolCallId: "call-1",
        t0: 1_700_000_000_000,
        params: { task: "t", timeoutMs: 1000, ...params },
        agentDef: undefined,
        modelCtx: {
          requestedModel: undefined,
          tier: undefined,
          capability: undefined,
          mainModel: undefined,
          displayModelBeforeResolve: "m",
        },
        spawnCwd: "/r",
        childSignal: new AbortController().signal,
      },
      { resolvedModel: undefined, fellBack: false, lastHistory: undefined, maxToolCallsSeen: 0 },
      {
        getActiveTools: () => ["read", "grep"],
        getExtensionTools: () => undefined,
        inFlight: undefined,
        persistence: undefined,
        onUpdate: undefined,
      },
    );
  } finally {
    if (savedHints === undefined) delete process.env.PI_SUBAGENT_HINTS_FILE;
    else process.env.PI_SUBAGENT_HINTS_FILE = savedHints;
  }
}

test("named dispatch appends request_plan_approval to the allowlist (default parent active set)", () => {
  const opts = spawnOptsFor({ name: "researcher" });
  assert.ok(opts.tools?.includes(REQUEST_PLAN_APPROVAL_TOOL_NAME));
});

test("one-shot dispatch does NOT carry request_plan_approval", () => {
  const opts = spawnOptsFor({});
  assert.ok(!opts.tools?.includes(REQUEST_PLAN_APPROVAL_TOOL_NAME));
});

test("explicit excludeTools still strips the protocol tool (deny wins in applyToolPolicy)", () => {
  const opts = spawnOptsFor({ name: "researcher", excludeTools: [REQUEST_PLAN_APPROVAL_TOOL_NAME] });
  // The allowlist still NAMES it (the append is unconditional for named
  // agents); the deny strips it at session assembly — pinned here against the
  // real applyToolPolicy, not by re-asserting the allowlist's content.
  assert.ok(opts.tools?.includes(REQUEST_PLAN_APPROVAL_TOOL_NAME));
  assert.ok(opts.excludeTools?.includes(REQUEST_PLAN_APPROVAL_TOOL_NAME));
  const kept = applyToolPolicy(
    [{ name: REQUEST_PLAN_APPROVAL_TOOL_NAME }, { name: "read" }],
    opts.tools,
    opts.excludeTools,
  );
  assert.deepEqual(
    kept.map((t) => t.name),
    ["read"],
  );
});
