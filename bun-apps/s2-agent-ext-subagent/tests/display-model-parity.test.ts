/**
 * Ticket 07 (cc-parity ledger hygiene):
 *  1. Display-model precedence is ONE shared resolver (`resolveDisplayModel`,
 *     model > capability > tier > mainModel > "default", with prefixed display
 *     strings) — the batch `list_subagents` slot model and the singular tool's
 *     background-track record both route through it, so the same inputs render
 *     the identical string on every surface.
 *  2. `agentType: ""` is a BAD TYPE NAME on both tools (schema minLength 1 +
 *     runtime `!== undefined` guards), never silently "no type".
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentDefinition, SpawnSubagentOptions, SpawnSubagentResult } from "@repo/s2-agent-core-runtime";
import { SubagentInFlightRegistry } from "@repo/s2-agent-core-runtime";
import { BackgroundRunManager } from "../src/background-run-manager.js";
import { createSubagentTool } from "../src/subagent-tool.js";
import { resolveDisplayModel } from "../src/subagent-tool-run.js";
import { subagentToolSchema } from "../src/subagent-tool-schema.js";
import { createSubagentsTool, subagentsToolSchema } from "../src/subagents-tool.js";
import { ok } from "./_spawn-result.js";

const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;
const noSnapshotOps = { snapshot: async () => undefined } as never;

function def(over: Partial<AgentDefinition> & { name: string }): AgentDefinition {
  return { prompt: `You are ${over.name}.`, source: "project", ...over };
}

// ── 1. the shared resolver: capability beats tier, prefixes, fallbacks ──

test("resolveDisplayModel orders model > capability > tier > mainModel > default across the matrix", () => {
  const m = "provider/explicit";
  const main = "provider/main";
  assert.equal(resolveDisplayModel(m, undefined, undefined, main), m, "explicit model wins outright");
  assert.equal(resolveDisplayModel(m, "vision", "big", main), m, "explicit model beats capability+tier");
  assert.equal(resolveDisplayModel(undefined, "vision", "big", main), "capability:vision", "capability beats tier");
  assert.equal(resolveDisplayModel(undefined, "vision", undefined, main), "capability:vision");
  assert.equal(resolveDisplayModel(undefined, undefined, "big", main), "tier:big");
  assert.equal(resolveDisplayModel(undefined, undefined, undefined, main), main, "session model fallback");
  assert.equal(resolveDisplayModel(undefined, undefined, undefined, undefined), "default");
});

test("batch slots render the SAME prefixed display strings as the singular path (shared resolver)", async () => {
  const tool = createSubagentsTool({
    cwd: "/repo",
    spawn: async () => ok("out"),
    getMainModel: () => "provider/main",
  });
  const res = await tool.execute(
    "call-dm",
    {
      tasks: [
        { task: "explicit model", model: "provider/explicit" },
        { task: "capability only", capability: "vision" },
        { task: "tier only", tier: "big" },
        { task: "capability + tier", capability: "vision", tier: "big" },
        { task: "neither" },
      ],
    },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const models = res.details.results.map((r) => (r as { model: string }).model);
  assert.deepEqual(models, [
    "provider/explicit",
    "capability:vision",
    "tier:big",
    "capability:vision", // the OLD batch chain rendered raw "big" here (tier first)
    "provider/main",
  ]);
});

test("batch folds the agentType definition's model/tier into the SAME precedence (definition below task fields)", async () => {
  const tool = createSubagentsTool({
    cwd: "/repo",
    spawn: async () => ok("out"),
    getMainModel: () => "provider/main",
    agentRegistry: new Map<string, AgentDefinition>([
      ["cheap", def({ name: "cheap", tier: "small" })],
      ["visionary", def({ name: "visionary", model: "provider/def-model" })],
    ]),
  });
  const res = await tool.execute(
    "call-dm-def",
    {
      tasks: [
        { task: "def tier", agentType: "cheap" },
        { task: "task tier beats def tier", agentType: "cheap", tier: "big" },
        { task: "def model", agentType: "visionary" },
      ],
    },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const models = res.details.results.map((r) => (r as { model: string }).model);
  assert.deepEqual(models, ["tier:small", "tier:big", "provider/def-model"]);
});

test("singular background track record carries the full display precedence (not model-or-default)", async () => {
  const manager = new BackgroundRunManager();
  const delivered: string[] = [];
  manager.setDeliverer((msg) => delivered.push(msg));
  const tool = createSubagentTool({
    gitSnapshotOps: noSnapshotOps,
    spawn: async (_opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => ok("done"),
    inFlight: new SubagentInFlightRegistry(),
    background: manager,
    gitOps: { headCommit: async () => "b1", changedPaths: async () => [] } as never,
  });
  const res = await tool.execute(
    "call-bg-tier",
    { task: "t", background: true, tier: "big" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.status, "running");
  for (let i = 0; i < 200 && delivered.length === 0; i++) await Promise.resolve();
  assert.equal(delivered.length, 1, "completion notification delivered");
  // The notification embeds the track record's model — previously this collapsed
  // to params.model ?? agentDef?.model ?? "default" (tier:big → "default").
  assert.match(delivered[0] ?? "", /model: tier:big/);
});

// ── 2. agentType "" is a bad type name, never silently "untyped" ──

test("both schemas declare agentType minLength 1", () => {
  const singular = (subagentToolSchema as { properties: { agentType: { minLength?: number } } }).properties.agentType;
  const batch = (
    subagentsToolSchema as unknown as {
      properties: { tasks: { items: { properties: { agentType: { minLength?: number } } } } };
    }
  ).properties.tasks.items.properties.agentType;
  assert.equal(singular.minLength, 1, "singular schema guards empty agentType");
  assert.equal(batch.minLength, 1, "batch schema guards empty agentType");
});

test("singular: agentType '' fails early as an unknown type (no silent untyped dispatch)", async () => {
  const tool = createSubagentTool({
    gitSnapshotOps: noSnapshotOps,
    spawn: async (_opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => ok("never"),
    agentRegistry: new Map<string, AgentDefinition>([["real", def({ name: "real" })]]),
  });
  const res = await tool.execute("call-empty-type", { task: "t", agentType: "" }, NO_SIGNAL, undefined, NO_CTX);
  assert.match((res.content[0] as { text: string }).text, /Unknown agentType ""/);
});

test("batch: agentType '' rejects the whole batch before dispatch as a bad type name", async () => {
  let spawned = 0;
  const tool = createSubagentsTool({
    cwd: "/repo",
    spawn: async () => {
      spawned++;
      return ok("never");
    },
    agentRegistry: new Map<string, AgentDefinition>([["real", def({ name: "real" })]]),
  });
  const res = await tool.execute(
    "call-empty-type-batch",
    { tasks: [{ task: "t0" }, { task: "t1", agentType: "" }] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match((res.content[0] as { text: string }).text, /Batch rejected before dispatch/);
  assert.match((res.content[0] as { text: string }).text, /\[1\] unknown agentType ""/);
  assert.equal(spawned, 0, "no child dispatched");
  assert.equal(res.details.dispatched, 0);
});
