/**
 * Named live agents (spawn_subagent `name` param — agent-teams parity ticket 01,
 * effort .planning/2026-08-22-subagent-teams-parity).
 *
 * Pins the tool-level contract on top of the core-runtime persistent-agent
 * unit tests: pre-flight validation, routing through the live first-exchange
 * runner instead of the one-shot spawn, registration in the live registry, the
 * durable record's agentName/agentId fields, and that unnamed dispatches are
 * byte-for-byte unaffected (spawn seam untouched).
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type LiveAgent,
  type LiveAgentRegistry,
  LiveAgentRegistry as LiveAgentRegistryClass,
  type SpawnSubagentOptions,
  type SubagentRunPersistence,
  type SubagentRunRecord,
} from "@repo/s2-agent-core-runtime";
import { createSubagentTool } from "../src/subagent-tool.js";
import { ok } from "./_spawn-result.js";

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

function fakePersistence() {
  const saved: SubagentRunRecord[] = [];
  return {
    saved,
    persistence: {
      save: (r: SubagentRunRecord) => {
        saved.push(r);
      },
      list: () => [...saved].reverse(),
      load: () => null,
      delete: () => false,
      getRunsDir: () => "/tmp",
    } as unknown as SubagentRunPersistence,
  };
}

/** Records the spawn opts the live runner received; returns a done exchange. */
function fakeSpawnLive(registry: LiveAgentRegistry) {
  const calls: SpawnSubagentOptions[] = [];
  const spawnLive = async (opts: SpawnSubagentOptions, open: { name: string; agentId: string }) => {
    calls.push(opts);
    const handle = fakeHandle();
    const entry = registry.register({ name: open.name, agentId: open.agentId, agent: handle, cwd: "/repo" });
    if ("error" in entry) {
      return { result: { output: "", failure: { kind: "failed" as const, message: entry.error } } };
    }
    return {
      result: { output: `live:${opts.task}`, usage: undefined },
      agent: handle as unknown as LiveAgent,
      entry,
    };
  };
  return { calls, spawnLive };
}

function fakeHandle() {
  return {
    status: "idle" as const,
    touch: () => {},
    dispose: () => {},
  };
}

function mkTool(overrides: Record<string, unknown> = {}) {
  const { saved, persistence } = fakePersistence();
  const liveRegistry = new LiveAgentRegistryClass(4);
  const { calls, spawnLive } = fakeSpawnLive(liveRegistry);
  const tool = createSubagentTool({
    cwd: "/repo",
    persistence,
    liveRegistry,
    spawnLive: spawnLive as never,
    ...overrides,
  } as never);
  return { tool, saved, liveRegistry, liveCalls: calls };
}

test("named dispatch routes through the live runner, registers, and stamps the record", async () => {
  const { tool, saved, liveRegistry, liveCalls } = mkTool();
  const res = await tool.execute(
    "call-1",
    { task: "research the seam", name: "researcher" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.status, "done");
  assert.match((res.content[0] as { text: string }).text, /live:research the seam/);
  // Routed through the live runner (not the one-shot spawn), registered under the name.
  assert.equal(liveCalls.length, 1);
  assert.equal(liveRegistry.get("researcher")?.agentId, "call-1");
  // Output surfaces addressability; the durable record carries the handle + id.
  assert.match((res.content[0] as { text: string }).text, /Named agent "researcher" is live/);
  assert.equal(saved[0].agentName, "researcher");
  assert.equal(saved[0].agentId, "call-1");
});

test("unnamed dispatch never touches the live runner or registry", async () => {
  const { tool, saved, liveRegistry, liveCalls } = mkTool({ spawn: async () => ok("one-shot output") });
  const res = await tool.execute("call-2", { task: "plain task" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.status, "done");
  assert.equal(liveCalls.length, 0);
  assert.equal(liveRegistry.size, 0);
  assert.equal(saved[0].agentName, undefined);
  assert.equal(saved[0].agentId, undefined);
});

test("`name` + `schema` fails pre-flight — nothing spawned", async () => {
  const { tool, liveRegistry, liveCalls } = mkTool();
  const res = await tool.execute(
    "call-3",
    { task: "t", name: "shaped", schema: { type: "object" } },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.status, "failed");
  assert.match((res.content[0] as { text: string }).text, /`name` \+ `schema`/);
  assert.equal(liveCalls.length, 0);
  assert.equal(liveRegistry.size, 0);
});

test("`name` + worktree-isolating agentType fails pre-flight", async () => {
  const { tool } = mkTool({
    agentRegistry: new Map([
      ["isolated-worker", { name: "isolated-worker", isolation: "worktree", prompt: "p", source: "project" }],
    ]),
  });
  const res = await tool.execute(
    "call-4",
    { task: "t", name: "iso", agentType: "isolated-worker" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.status, "failed");
  assert.match((res.content[0] as { text: string }).text, /worktree isolation/);
});

test("reserved name `main` and collisions fail pre-flight with the live roster", async () => {
  const { tool, liveRegistry } = mkTool();
  const reserved = await tool.execute("c-r", { task: "t", name: "main" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(reserved.details.status, "failed");
  assert.match((reserved.content[0] as { text: string }).text, /reserved/);

  liveRegistry.register({ name: "researcher", agentId: "x", agent: fakeHandle(), cwd: "/repo" });
  const dup = await tool.execute("c-d", { task: "t", name: "researcher" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(dup.details.status, "failed");
  assert.match((dup.content[0] as { text: string }).text, /a live agent named "researcher" already exists/);
});

test("an exhausted live-agent cap fails pre-flight (all agents mid-exchange)", async () => {
  const { saved, persistence } = fakePersistence();
  const liveRegistry = new LiveAgentRegistryClass(1);
  liveRegistry.register({
    name: "busy",
    agentId: "b",
    agent: { ...fakeHandle(), status: "running" },
    cwd: "/repo",
  });
  const { spawnLive } = fakeSpawnLive(liveRegistry);
  const tool = createSubagentTool({
    cwd: "/repo",
    persistence,
    liveRegistry,
    spawnLive: spawnLive as never,
  } as never);
  const res = await tool.execute("c-cap", { task: "t", name: "next" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.status, "failed");
  assert.match((res.content[0] as { text: string }).text, /cap reached/);
  assert.equal(saved.length, 0); // pre-flight — not a real run, nothing persisted
});
