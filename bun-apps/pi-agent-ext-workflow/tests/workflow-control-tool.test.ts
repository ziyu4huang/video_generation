import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWorkflowSnapshot } from "../src/display.js";
import { createWorkflowControlTool } from "../src/workflow-control-tool.js";
import type { WorkflowManager } from "../src/workflow-manager.js";

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

/** Same fake-manager pattern as tests/workflow-commands.test.ts, plus real
 *  EventEmitter behavior so the `wait` action (Task 5) can be tested by
 *  emitting events directly. */
function fakeManager(overrides: Record<string, any> = {}) {
  const calls: string[] = [];
  const base = {
    listRuns: () => [],
    getSnapshot: () => null,
    getRun: () => undefined,
    stop: (id: string) => {
      calls.push(`stop:${id}`);
      return false;
    },
    pause: (id: string) => {
      calls.push(`pause:${id}`);
      return false;
    },
    resume: async (id: string) => {
      calls.push(`resume:${id}`);
      return false;
    },
  };
  const manager = Object.assign(new EventEmitter(), base, overrides);
  return { manager: manager as unknown as WorkflowManager, calls };
}

async function textOf(result: { content: Array<{ type: string; text?: string }> }): Promise<string> {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

test("createWorkflowControlTool has name 'workflow_control'", () => {
  const { manager } = fakeManager();
  const tool = createWorkflowControlTool({ manager });
  assert.equal(tool.name, "workflow_control");
});

test("action=stop with no runId throws", async () => {
  const { manager } = fakeManager();
  const tool = createWorkflowControlTool({ manager });
  await assert.rejects(() => tool.execute("id", { action: "stop" }, NO_SIGNAL, undefined, NO_CTX));
});

test("action=stop on a running run calls manager.stop and reports success", async () => {
  const { manager, calls } = fakeManager({ stop: (id: string) => (calls.push(`stop:${id}`), true) });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "stop", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(calls, ["stop:run-1"]);
  assert.match(await textOf(res), /Stopped run-1/);
});

test("action=stop on an unknown/non-running run lists currently-running ids", async () => {
  const { manager } = fakeManager({
    stop: () => false,
    listRuns: () => [
      { runId: "run-2", status: "running" },
      { runId: "run-3", status: "completed" },
    ],
  });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "stop", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  const text = await textOf(res);
  assert.match(text, /Cannot stop run-1/);
  assert.match(text, /run-2/);
  assert.doesNotMatch(text, /run-3/, "only running runs are listed, not completed ones");
});

test("action=stop when nothing is running says so instead of an empty list", async () => {
  const { manager } = fakeManager({ stop: () => false, listRuns: () => [] });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "stop", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /No runs are currently running/);
});

test("action=pause calls manager.pause", async () => {
  const { manager, calls } = fakeManager({ pause: (id: string) => (calls.push(`pause:${id}`), true) });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "pause", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(calls, ["pause:run-1"]);
  assert.match(await textOf(res), /Paused run-1/);
});

test("action=resume calls manager.resume (async)", async () => {
  const { manager, calls } = fakeManager({ resume: async (id: string) => (calls.push(`resume:${id}`), true) });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "resume", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(calls, ["resume:run-1"]);
  assert.match(await textOf(res), /Resumed run-1/);
});

test("action=resume reports failure when nothing resumable", async () => {
  const { manager } = fakeManager({ resume: async () => false });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "resume", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /Resume not available/);
});

test("action=status with no runId throws", async () => {
  const { manager } = fakeManager();
  const tool = createWorkflowControlTool({ manager });
  await assert.rejects(() => tool.execute("id", { action: "status" }, NO_SIGNAL, undefined, NO_CTX));
});

test("action=status on a live run renders the live snapshot + a no-poll hint", async () => {
  const snapshot = createWorkflowSnapshot({ name: "audit", description: "d", phases: [] });
  snapshot.agents.push({ id: 1, label: "scan", status: "running" } as never);
  const { manager } = fakeManager({ getSnapshot: (id: string) => (id === "run-1" ? snapshot : null) });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "status", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  const text = await textOf(res);
  assert.match(text, /audit/);
  assert.match(text, /wait/i, "includes the prefer-notification-over-polling hint");
});

test("action=status on a finished (persisted-only) run falls back to renderPersistedStatus", async () => {
  const { manager } = fakeManager({
    getSnapshot: () => null,
    listRuns: () => [{ runId: "run-1", workflowName: "audit", status: "completed", phases: [], agents: [], logs: [] }],
  });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "status", runId: "run-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /audit/);
});

test("action=status on an unknown runId says so", async () => {
  const { manager } = fakeManager({ getSnapshot: () => null, listRuns: () => [] });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "status", runId: "nope" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /No workflow run "nope"/);
});

test("action=list with no runs says so", async () => {
  const { manager } = fakeManager({ listRuns: () => [] });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match(await textOf(res), /No workflow runs yet/);
});

test("action=list renders every run + a no-poll hint", async () => {
  const { manager } = fakeManager({
    listRuns: () => [
      { runId: "run-1", workflowName: "audit", status: "running", phases: [], agents: [], logs: [] },
      { runId: "run-2", workflowName: "review", status: "completed", phases: [], agents: [], logs: [] },
    ],
  });
  const tool = createWorkflowControlTool({ manager });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, NO_CTX);
  const text = await textOf(res);
  assert.match(text, /run-1/);
  assert.match(text, /run-2/);
  assert.match(text, /wait/i, "includes the prefer-notification-over-polling hint");
});
