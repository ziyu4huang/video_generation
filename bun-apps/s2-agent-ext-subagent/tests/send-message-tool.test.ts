/**
 * send_message tool (agent-teams parity ticket 02,
 * effort .planning/2026-08-22-subagent-teams-parity).
 *
 * Pins the routing contract on fake LiveAgentHandles registered in a real
 * LiveAgentRegistry: idle → awaited re-prompt, running → steer, unknown →
 * roster error, wait:false → immediate return + task-notification, terminal
 * budget failure → agent released, to:"main" → ParentMessageBus delivery,
 * and that read-only batch children keep the tool (READ_ONLY_EXCLUDED).
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type LiveAgentHandle,
  type LiveAgentRegistry,
  LiveAgentRegistry as LiveAgentRegistryClass,
  type LiveAgentSendResult,
} from "@repo/s2-agent-core-runtime";
import type { BackgroundRunOutcome, BackgroundRunSpec } from "../src/background-run-manager.js";
import { ParentMessageBus } from "../src/parent-message-bus.js";
import { createSendMessageTool } from "../src/send-message-tool.js";
import { READ_ONLY_EXCLUDED } from "../src/subagents-tool.js";

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

interface FakeState {
  sends: Array<{ text: string; opts?: { timeoutMs?: number; signal?: AbortSignal } }>;
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

function mkTool() {
  const liveRegistry: LiveAgentRegistry = new LiveAgentRegistryClass(4);
  const bus = new ParentMessageBus();
  const notifications: Array<{ spec: BackgroundRunSpec; outcome: BackgroundRunOutcome }> = [];
  const tool = createSendMessageTool({
    liveRegistry,
    bus,
    background: {
      notify: (spec: BackgroundRunSpec, outcome: BackgroundRunOutcome) => notifications.push({ spec, outcome }),
    },
  });
  return { tool, liveRegistry, bus, notifications };
}

const text = (r: { content: Array<{ type: string; text: string }> }) => r.content[0]?.text ?? "";

test("idle agent: awaited send returns the reply (default wait)", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent } = fakeAgent([{ output: "final answer" }]);
  liveRegistry.register({ name: "researcher", agentId: "call-1", agent, cwd: "/repo", model: "x/y" });
  const res = await tool.execute("t1", { to: "researcher", message: "summarize" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /final answer/);
});

test("resolves by agentId as well as name", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent, state } = fakeAgent();
  liveRegistry.register({ name: "researcher", agentId: "call-9", agent, cwd: "/repo" });
  await tool.execute("t2", { to: "call-9", message: "hi" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(state.sends.length, 1);
});

test("unknown target: error listing the live roster", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent } = fakeAgent();
  liveRegistry.register({ name: "researcher", agentId: "c", agent, cwd: "/repo" });
  const res = await tool.execute("t3", { to: "ghost", message: "hi" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /No live agent "ghost"/);
  assert.match(text(res), /researcher/);
});

test("running agent: steer — delivered immediately, no blocking on the in-flight exchange", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent } = fakeAgent([{ output: "", steered: true }], "running");
  liveRegistry.register({ name: "worker", agentId: "c", agent, cwd: "/repo" });
  const res = await tool.execute("t4", { to: "worker", message: "pivot" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /Delivered to "worker"/);
  assert.match(text(res), /steer/i);
});

test("wait:false returns immediately; the reply lands as a task-notification", async () => {
  const { tool, liveRegistry, notifications } = mkTool();
  // send() hangs until released — proves the tool call did NOT await it.
  let release: (() => void) | undefined;
  const pending = new Promise<LiveAgentSendResult>((resolve) => {
    release = () => resolve({ output: "late reply" });
  });
  const { agent } = fakeAgent([pending]);
  liveRegistry.register({ name: "slow", agentId: "call-slow", agent, cwd: "/repo", model: "p/m" });
  const res = await tool.execute("t5", { to: "slow", message: "go", wait: false }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /task-notification/);
  assert.equal(notifications.length, 0);
  release?.();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(notifications.length, 1);
  const n = notifications[0];
  assert.equal(n.spec.id, "call-slow");
  assert.equal(n.spec.agent, "slow");
  assert.equal(n.outcome.status, "done");
  assert.match(n.outcome.output ?? "", /late reply/);
});

test("wait:false on a running agent steers without a notification", async () => {
  const { tool, liveRegistry, notifications } = mkTool();
  const { agent } = fakeAgent([{ output: "", steered: true }], "running");
  liveRegistry.register({ name: "busy", agentId: "c", agent, cwd: "/repo" });
  const res = await tool.execute("t6", { to: "busy", message: "nudge", wait: false }, NO_SIGNAL, undefined, NO_CTX);
  // wait:false + running takes the awaited path (only idle agents fire-and-forget)
  // — send() steers and returns steered:true immediately.
  assert.match(text(res), /Delivered to "busy"/);
  assert.equal(notifications.length, 0);
});

test("timeout exchange: surfaced, session stays live (no release)", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent } = fakeAgent([{ output: "", failure: { kind: "timedout", message: "exchange aborted (timeout)" } }]);
  liveRegistry.register({ name: "slow", agentId: "c", agent, cwd: "/repo" });
  const res = await tool.execute("t7", { to: "slow", message: "hi", timeoutMs: 50 }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /did not complete \(timedout\)/);
  assert.match(text(res), /stays live/);
  assert.ok(liveRegistry.get("slow"));
});

test("terminal budget failure: message refused, agent released from the roster", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent, state } = fakeAgent([
    {
      output: "",
      failure: { kind: "budget", message: "lifetime token/spend budget exhausted (1000 tokens > limit 900)" },
    },
  ]);
  liveRegistry.register({ name: "spender", agentId: "c", agent, cwd: "/repo" });
  const res = await tool.execute("t8", { to: "spender", message: "hi" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /Message not delivered/);
  assert.match(text(res), /terminated and removed/);
  assert.equal(liveRegistry.get("spender"), undefined);
  assert.equal(state.disposed, 1); // release() disposed the handle
});

test("to:'main' publishes through the bus (fake deliverer) with self-declared from", async () => {
  const { tool, bus } = mkTool();
  const delivered: string[] = [];
  bus.setDeliverer((msg) => delivered.push(msg));
  const res = await tool.execute(
    "t9",
    { to: "main", message: "status: halfway done", from: "researcher" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match(text(res), /Delivered to the parent session/);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /<agent-message>/);
  assert.match(delivered[0], /"researcher"/);
  assert.match(delivered[0], /halfway done/);
});

test("to:'main' with no wired deliverer: actionable error, no throw", async () => {
  const { tool } = mkTool();
  const res = await tool.execute("t10", { to: "main", message: "hello?" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /bus is not wired/);
});

test("read-only batch children keep send_message (not in READ_ONLY_EXCLUDED)", () => {
  assert.ok(!READ_ONLY_EXCLUDED.includes("send_message"));
});

test("empty reply is surfaced honestly", async () => {
  const { tool, liveRegistry } = mkTool();
  const { agent } = fakeAgent([{ output: "" }]);
  liveRegistry.register({ name: "quiet", agentId: "c", agent, cwd: "/repo" });
  const res = await tool.execute("t11", { to: "quiet", message: "hi" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(text(res), /empty reply/);
});
