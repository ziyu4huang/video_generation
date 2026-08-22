/**
 * Team addressing (agent-teams parity ticket 05,
 * effort .planning/2026-08-22-subagent-teams-parity).
 *
 * Pins the brokered-routing contract on fake LiveAgentHandles in a real
 * LiveAgentRegistry with a fake-wired ParentMessageBus: a named child's
 * message to a teammate is delivered into the target AND relayed to the
 * parent (both see it), protocol envelopes aimed at teammates refuse,
 * self-address is a no-op error, the roster renders from the live registry,
 * and the spawn path stamps the named child's own send_message instance.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type LiveAgentHandle,
  type LiveAgentRegistry,
  LiveAgentRegistry as LiveAgentRegistryClass,
  type LiveAgentSendResult,
  type SubagentRunPersistence,
  type SubagentRunRecord,
} from "@repo/s2-agent-core-runtime";
import { ParentMessageBus } from "../src/parent-message-bus.js";
import {
  createSendMessageTool,
  formatSiblingRelayNotification,
  formatSiblingReplyNotification,
} from "../src/send-message-tool.js";
import { createSubagentRunsTool, renderLiveRoster } from "../src/subagent-runs-tool.js";
import { buildSpawnOptions, type RunProgress } from "../src/subagent-tool-run.js";

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

/** Controllable LiveAgentHandle double — send() returns scripted results per call. */
function fakeAgent(script: Array<LiveAgentSendResult | Error> = [], status: "running" | "idle" = "idle") {
  const state = { sends: [] as Array<{ text: string; opts?: { timeoutMs?: number } }>, status, disposed: 0 };
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

/** A child-side tool instance (selfName stamped) + a parent-observing fake bus. */
function mkChild(selfName: string) {
  const liveRegistry: LiveAgentRegistry = new LiveAgentRegistryClass(4);
  const bus = new ParentMessageBus();
  const toParent: string[] = [];
  bus.setDeliverer((msg) => toParent.push(msg));
  const tool = createSendMessageTool({ liveRegistry, bus, selfName });
  return { tool, liveRegistry, bus, toParent };
}

const text = (r: { content: Array<{ type: string; text: string }> }) => r.content[0]?.text ?? "";

// ---------------------------------------------------------------------------
// Brokered delivery — both sides see it
// ---------------------------------------------------------------------------

test("named child → running teammate: steer into the exchange AND relay to the parent", async () => {
  const { tool, liveRegistry, toParent } = mkChild("researcher");
  const { agent, state } = fakeAgent([{ output: "", steered: true }], "running");
  liveRegistry.register({ name: "writer", agentId: "call-w", agent, cwd: "/repo", model: "p/m" });

  const res = await tool.execute(
    "t1",
    { to: "writer", message: "pivot to the API angle" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );

  // Delivered into the target (the steer send happened, message verbatim).
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].text, "pivot to the API angle");
  // Surfaced to the parent: exactly one relay naming both endpoints.
  assert.equal(toParent.length, 1);
  assert.match(toParent[0], /researcher/);
  assert.match(toParent[0], /writer/);
  assert.match(toParent[0], /pivot to the API angle/);
  // The sender was told both halves.
  assert.match(text(res), /Delivered to teammate "writer"/);
  assert.match(text(res), /steer/i);
});

test("named child → idle teammate: fresh fire-and-forget exchange; the reply relays to the parent on settle", async () => {
  const { tool, liveRegistry, toParent } = mkChild("researcher");
  // send() hangs until released — proves the tool call did NOT await the reply.
  let release: (() => void) | undefined;
  const pending = new Promise<LiveAgentSendResult>((resolve) => {
    release = () => resolve({ output: "the reply" });
  });
  const { agent, state } = fakeAgent([pending]);
  liveRegistry.register({ name: "writer", agentId: "call-w", agent, cwd: "/repo", model: "p/m" });

  const res = await tool.execute("t2", { to: "writer", message: "draft the summary" }, NO_SIGNAL, undefined, NO_CTX);

  // The exchange started immediately; the sender got its delivery receipt now.
  assert.equal(state.sends.length, 1);
  assert.match(text(res), /Delivered to teammate "writer"/);
  // Only the RELAY has landed with the parent so far (the reply is pending).
  assert.equal(toParent.length, 1);
  assert.match(toParent[0], /draft the summary/);

  release?.();
  await new Promise((r) => setTimeout(r, 10));
  // The reply surfaced to the parent too — both halves of the conversation.
  assert.equal(toParent.length, 2);
  assert.match(toParent[1], /the reply/);
  assert.match(toParent[1], /writer/);
  assert.match(toParent[1], /researcher/);
});

test("named child → idle teammate terminal failure: released from the roster, failure relayed", async () => {
  const { tool, liveRegistry, toParent } = mkChild("researcher");
  const { agent } = fakeAgent([{ output: "", failure: { kind: "budget", message: "token budget exhausted" } }]);
  liveRegistry.register({ name: "writer", agentId: "call-w", agent, cwd: "/repo" });

  await tool.execute("t3", { to: "writer", message: "go" }, NO_SIGNAL, undefined, NO_CTX);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(liveRegistry.names().length, 0, "terminal failure releases the teammate");
  assert.ok(
    toParent.some((m) => m.includes("budget")),
    "the failure is relayed to the parent",
  );
});

test("unknown teammate: roster error names the live agents", async () => {
  const { tool, liveRegistry } = mkChild("researcher");
  const { agent } = fakeAgent();
  liveRegistry.register({ name: "writer", agentId: "call-w", agent, cwd: "/repo" });
  const res = await tool.execute("t4", { to: "ghost", message: "hi" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /No live agent "ghost"/);
  assert.match(text(res), /writer/);
});

test("self-address: explicit no-op error", async () => {
  const { tool, liveRegistry } = mkChild("researcher");
  const { agent, state } = fakeAgent();
  liveRegistry.register({ name: "researcher", agentId: "call-r", agent, cwd: "/repo" });
  const res = await tool.execute("t5", { to: "researcher", message: "note to self" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /is YOU/);
  assert.equal(state.sends.length, 0);
});

test("unwired bus: brokered send refuses rather than delivering silently", async () => {
  const liveRegistry: LiveAgentRegistry = new LiveAgentRegistryClass(4);
  const bus = new ParentMessageBus(); // no deliverer — detached/test host
  const tool = createSendMessageTool({ liveRegistry, bus, selfName: "researcher" });
  const { agent, state } = fakeAgent();
  liveRegistry.register({ name: "writer", agentId: "call-w", agent, cwd: "/repo" });
  const res = await tool.execute("t6", { to: "writer", message: "hi" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /failed/);
  assert.equal(state.sends.length, 0, "no delivery without the parent half");
});

// ---------------------------------------------------------------------------
// Protocol envelopes from a child at a teammate — refused
// ---------------------------------------------------------------------------

test("child shutdown_request aimed at a teammate refuses (no parent-grade levers without the parent)", async () => {
  const { tool, liveRegistry } = mkChild("researcher");
  const { agent, state } = fakeAgent();
  liveRegistry.register({ name: "writer", agentId: "call-w", agent, cwd: "/repo" });
  const res = await tool.execute(
    "t7",
    { to: "writer", message: "wrap up", type: "shutdown_request" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /never a teammate/);
  assert.equal(state.sends.length, 0);
  assert.equal(liveRegistry.names().length, 1, "the teammate was not stopped");
});

// ---------------------------------------------------------------------------
// Child identity — the stamp defaults `from`
// ---------------------------------------------------------------------------

test("named child's to:'main' publishes under its stamped name (no explicit from)", async () => {
  const { tool, toParent } = mkChild("researcher");
  await tool.execute("t8", { to: "main", message: "status: halfway" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(toParent.length, 1);
  assert.match(toParent[0], /"researcher"/);
});

// ---------------------------------------------------------------------------
// Relay formatting — preview caps
// ---------------------------------------------------------------------------

test("relay notification truncates over-cap messages with a re-send hint", () => {
  const long = "x".repeat(5000);
  const relay = formatSiblingRelayNotification("a", "b", long);
  assert.ok(relay.length < 5000, "capped, not verbatim");
  assert.match(relay, /truncated relay/);
  assert.match(relay, /"a" → "b"/);
  // Under the cap: verbatim, no marker.
  assert.ok(!formatSiblingRelayNotification("a", "b", "short").includes("truncated"));
});

test("reply notification carries status + capped body", () => {
  const ok = formatSiblingReplyNotification("writer", "researcher", { output: "done: all green" });
  assert.match(ok, /"writer" → "researcher" \(done\)/);
  assert.match(ok, /done: all green/);
  const failed = formatSiblingReplyNotification("writer", "researcher", {
    output: "",
    failure: { kind: "timeout", message: "exchange timed out" },
  });
  assert.match(failed, /timeout/);
  assert.match(failed, /exchange timed out/);
  assert.ok(failed.length < 5000);
});

// ---------------------------------------------------------------------------
// Roster — list_subagent_runs 'list' live section
// ---------------------------------------------------------------------------

function fakePersistence(records: SubagentRunRecord[]): SubagentRunPersistence {
  return {
    save: () => {},
    list: () => records,
    load: (id) => records.find((r) => r.id === id) ?? null,
    delete: () => false,
    getRunsDir: () => "/tmp/fake",
  };
}

test("renderLiveRoster: names, status, model, agentId, recency", () => {
  const liveRegistry: LiveAgentRegistry = new LiveAgentRegistryClass(4);
  const idle = fakeAgent();
  const running = fakeAgent([], "running");
  liveRegistry.register({
    name: "researcher",
    agentId: "call-r",
    agent: idle.agent,
    cwd: "/repo",
    model: "zai/glm-5.2",
  });
  liveRegistry.register({ name: "writer", agentId: "call-w", agent: running.agent, cwd: "/repo" });
  const now = Date.now();
  liveRegistry.touch("researcher");
  const roster = renderLiveRoster(liveRegistry, now + 60_000) as string;
  assert.match(roster, /team roster/i);
  assert.match(roster, /researcher/);
  assert.match(roster, /\[idle\]/);
  assert.match(roster, /zai\/glm-5\.2/);
  assert.match(roster, /agentId=call-r/);
  assert.match(roster, /1m ago/);
  assert.match(roster, /writer/);
  assert.match(roster, /\[running\]/);
});

test("renderLiveRoster: empty roster says none; absent registry renders nothing", () => {
  const empty = renderLiveRoster(new LiveAgentRegistryClass(4)) as string;
  assert.match(empty, /none/);
  assert.equal(renderLiveRoster(undefined), undefined);
});

test("list action appends the live roster after the run archive", async () => {
  const liveRegistry: LiveAgentRegistry = new LiveAgentRegistryClass(4);
  const { agent } = fakeAgent([], "running");
  liveRegistry.register({ name: "writer", agentId: "call-w", agent, cwd: "/repo", model: "p/m" });
  const tool = createSubagentRunsTool({
    persistence: fakePersistence([
      {
        id: "r1",
        toolCallId: "tc1",
        task: "t",
        model: "m",
        cwd: "/repo",
        status: "done",
        startedAt: "2026-08-22T10:00:00Z",
        elapsedMs: 5,
        output: "o",
      },
    ]),
    liveRegistry,
  });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, NO_CTX);
  const out = text(res as { content: Array<{ type: string; text: string }> });
  const archiveIx = out.indexOf("Subagent run history");
  const rosterIx = out.indexOf("Live named agents");
  assert.ok(archiveIx >= 0 && rosterIx > archiveIx, "roster rides AFTER the archive");
  assert.match(out, /writer/);
  assert.match(out, /\[running\]/);
});

// ---------------------------------------------------------------------------
// Spawn wiring — the named child gets its own stamped instance
// ---------------------------------------------------------------------------

function buildExtTools(params: Record<string, unknown>, extensionTools: unknown[]) {
  const progress: RunProgress = {
    resolvedModel: undefined,
    fellBack: false,
    lastHistory: undefined,
    maxToolCallsSeen: 0,
  };
  return buildSpawnOptions(
    {
      toolCallId: "call-x",
      t0: 1,
      params: { task: "T", ...params } as never,
      agentDef: undefined,
      modelCtx: {
        requestedModel: undefined,
        tier: undefined,
        capability: undefined,
        mainModel: undefined,
        displayModelBeforeResolve: "req",
      },
      spawnCwd: "/r",
      childSignal: new AbortController().signal,
    },
    progress,
    {
      getActiveTools: () => undefined,
      getExtensionTools: () => extensionTools,
      makeChildSendTool: (n) => ({ name: "send_message", selfName: n }),
    },
  );
}

test("named dispatch swaps in the selfName-stamped send_message; other defs untouched", () => {
  const shared = { name: "send_message", shared: true };
  const other = { name: "task_create" };
  const opts = buildExtTools({ name: "researcher" }, [other, shared]);
  const defs = opts.extensionTools as Array<{ name?: string; selfName?: string; shared?: boolean }>;
  assert.equal(defs.length, 2);
  assert.equal(defs[0], other, "non-send_message defs pass through by identity");
  assert.equal(defs[1].name, "send_message");
  assert.equal(defs[1].selfName, "researcher");
  assert.equal(defs[1].shared, undefined, "the shared parent instance was replaced, not mutated");
});

test("unnamed dispatch keeps the shared parent instance (no brokering semantics)", () => {
  const shared = { name: "send_message", shared: true };
  const opts = buildExtTools({}, [shared]);
  assert.equal((opts.extensionTools as unknown[])[0], shared, "by identity — untouched");
});

test("host without a send_message def: the stamp maps nothing across", () => {
  const only = { name: "task_create" };
  const opts = buildExtTools({ name: "researcher" }, [only]);
  assert.equal((opts.extensionTools as unknown[])[0], only);
});
