/**
 * Regression tests for the `subagent` tool's core contract (src/subagent-tool.ts).
 *
 * subagent-tool.test.ts already covers each v2 capability (usage/cost, agentType
 * binding, worktree isolation, schema, live progress) in isolation. This file
 * pins down cross-cutting invariants that a change to any single capability
 * could silently break without any single-capability test noticing:
 *
 *   1. concurrency     — two simultaneous worktree-isolated calls never cross wires
 *   2. cleanup-on-throw — worktree teardown runs even if spawn() rejects, not just
 *                         when it resolves with a failed SpawnSubagentResult
 *   3. fail-fast        — an unknown agentType never touches worktree creation
 *   4. composition       — agentType + schema + usage + live progress all work
 *                         together in one call, not just individually
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentDefinition, AgentRegistry } from "@repo/pi-agent-ext-core-runtime";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "../src/spawn-subagent.js";
import { createSubagentTool } from "../src/subagent-tool.js";

function mkRegistry(defs: AgentDefinition[]): AgentRegistry {
  const registry: AgentRegistry = new Map();
  for (const d of defs) registry.set(d.name, d);
  return registry;
}

function fakeSpawn(impl: (opts: SpawnSubagentOptions) => SpawnSubagentResult | Promise<SpawnSubagentResult>) {
  const calls: SpawnSubagentOptions[] = [];
  return {
    calls,
    spawn: async (opts: SpawnSubagentOptions) => {
      calls.push(opts);
      return impl(opts);
    },
  };
}

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

test("two concurrent worktree-isolated subagent calls get distinct cwds and each worktree is torn down exactly once", async () => {
  const registry = mkRegistry([
    { name: "isolated-worker", isolation: "worktree", prompt: "Work in isolation.", source: "project" },
  ]);
  const createCalls: Array<{ baseCwd: string; name: string }> = [];
  const removeCalls: string[] = [];
  const tool = createSubagentTool({
    spawn: async (opts) => {
      // Give both calls' create-worktree phases room to interleave before either resolves.
      await new Promise((r) => setTimeout(r, 5));
      return { output: `ok:${opts.cwd}`, exitCode: 0, stderr: "", timedOut: false };
    },
    agentRegistry: registry,
    cwd: "/repo",
    createWorktree: async (baseCwd, name) => {
      createCalls.push({ baseCwd, name });
      // Stagger so the SECOND call's create resolves before the FIRST's —
      // proves no shared mutable state crosses between the two execute() calls.
      await new Promise((r) => setTimeout(r, name.endsWith("call-A") ? 8 : 2));
      return { isolated: true, cwd: `/repo/.pi/worktrees/${name}`, repoRoot: "/repo", branch: `pi/wf/${name}` };
    },
    removeWorktree: async (wt) => {
      removeCalls.push(wt.cwd);
    },
  });

  const [resA, resB] = await Promise.all([
    tool.execute("call-A", { task: "t", agentType: "isolated-worker" }, NO_SIGNAL, undefined, NO_CTX),
    tool.execute("call-B", { task: "t", agentType: "isolated-worker" }, NO_SIGNAL, undefined, NO_CTX),
  ]);

  assert.equal(createCalls.length, 2);
  assert.deepEqual(createCalls.map((c) => c.name).sort(), ["subagent-call-A", "subagent-call-B"]);
  assert.match(
    (resA.content[0] as { text: string }).text,
    /\/repo\/\.pi\/worktrees\/subagent-call-A/,
    "call A's result reflects call A's own worktree, not call B's",
  );
  assert.match(
    (resB.content[0] as { text: string }).text,
    /\/repo\/\.pi\/worktrees\/subagent-call-B/,
    "call B's result reflects call B's own worktree, not call A's",
  );
  assert.equal(removeCalls.length, 2);
  assert.ok(removeCalls.includes("/repo/.pi/worktrees/subagent-call-A"));
  assert.ok(removeCalls.includes("/repo/.pi/worktrees/subagent-call-B"));
});

test("worktree is torn down even when spawn() rejects, not just when it resolves with a failed result", async () => {
  const registry = mkRegistry([
    { name: "isolated-worker", isolation: "worktree", prompt: "Work in isolation.", source: "project" },
  ]);
  let removed = false;
  const tool = createSubagentTool({
    spawn: async () => {
      throw new Error("spawn exploded");
    },
    agentRegistry: registry,
    cwd: "/repo",
    createWorktree: async (_baseCwd, name) => ({
      isolated: true,
      cwd: `/repo/.pi/worktrees/${name}`,
      repoRoot: "/repo",
      branch: `pi/wf/${name}`,
    }),
    removeWorktree: async () => {
      removed = true;
    },
  });

  await assert.rejects(
    () => tool.execute("id", { task: "t", agentType: "isolated-worker" }, NO_SIGNAL, undefined, NO_CTX),
    /spawn exploded/,
  );
  assert.equal(
    removed,
    true,
    "worktree cleanup must run even when spawn() throws instead of returning a failed result",
  );
});

test("unknown agentType never attempts to create a worktree, even when other registry entries use isolation:'worktree'", async () => {
  const registry = mkRegistry([
    { name: "isolated-worker", isolation: "worktree", prompt: "Work in isolation.", source: "project" },
  ]);
  let createCalls = 0;
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({
    spawn: f.spawn,
    agentRegistry: registry,
    cwd: "/repo",
    createWorktree: async () => {
      createCalls++;
      return { isolated: true, cwd: "/x", repoRoot: "/repo", branch: "b" };
    },
    removeWorktree: async () => {},
  });

  const res = await tool.execute("id", { task: "t", agentType: "nope" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(createCalls, 0, "resolving the agentType must fail before worktree creation is ever attempted");
  assert.equal(f.calls.length, 0);
  assert.equal(res.details.status, "failed");
});

test("agentType + schema + usage + live progress all compose correctly in a single call", async () => {
  const registry = mkRegistry([
    {
      name: "structured-worker",
      tools: ["read"],
      model: "openai/gpt-4.1",
      prompt: "Return structured output.",
      isolation: "worktree",
      source: "project",
    },
  ]);
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.001 };
  const history = [{ role: "assistant" as const, kind: "toolCall" as const, toolName: "read", text: "{}" }];
  const f = fakeSpawn(async (opts) => {
    (opts.onHistory as ((h: typeof history) => void) | undefined)?.(history);
    return { output: '{"ok":true}', exitCode: 0, stderr: "", timedOut: false, usage };
  });
  const tool = createSubagentTool({
    spawn: f.spawn,
    agentRegistry: registry,
    cwd: "/repo",
    createWorktree: async (_baseCwd, name) => ({
      isolated: true,
      cwd: `/repo/.pi/worktrees/${name}`,
      repoRoot: "/repo",
      branch: `pi/wf/${name}`,
    }),
    removeWorktree: async () => {},
  });
  const updates: Array<{ content: Array<{ type: string; text?: string }> }> = [];
  const res = await tool.execute(
    "id",
    { task: "t", agentType: "structured-worker", schema, timeoutMs: 5000, retryOnTransient: false },
    NO_SIGNAL,
    (u) => updates.push(u as never),
    NO_CTX,
  );

  assert.equal(f.calls[0]?.cwd, "/repo/.pi/worktrees/subagent-id", "worktree isolation still applies");
  assert.deepEqual(f.calls[0]?.schema, schema, "schema forwarded alongside the agentType binding");
  assert.equal(f.calls[0]?.model, "openai/gpt-4.1", "model resolved from the agentType binding");
  assert.equal(f.calls[0]?.timeoutMs, 5000);
  assert.equal(f.calls[0]?.retryOnTransient, false);
  assert.deepEqual(res.details.usage, usage, "usage surfaced alongside the agentType binding");
  assert.equal(updates.length, 1, "live progress still streams when agentType/schema are also in play");
});
