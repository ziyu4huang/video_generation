import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentHistoryEntry } from "../src/agent-history.js";
import type { GitScopeOps } from "../src/git-scope.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "../src/spawn-subagent.js";
import { SubagentInFlightRegistry } from "../src/subagent-in-flight.js";
import type { SubagentRunPersistence, SubagentRunRecord } from "../src/subagent-run-persistence.js";
import type { SubagentToolDetails } from "../src/subagent-tool.js";
import {
  createSubagentTool,
  deriveSubagentStatus,
  formatSubagentLive,
  formatSubagentProgress,
  formatSubagentResult,
  renderSubagentCall,
  renderSubagentResult,
  taskPreview,
} from "../src/subagent-tool.js";

/** Injectable spawn that records the opts it was called with. */
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

import type { AgentDefinition, AgentRegistry } from "../src/agent-registry.js";

function mkRegistry(defs: AgentDefinition[]): AgentRegistry {
  const registry: AgentRegistry = new Map();
  for (const d of defs) registry.set(d.name, d);
  return registry;
}

// ── factory shape (mirrors tests/workflow-tool.test.ts) ──
test("createSubagentTool has name 'subagent' + label 'Subagent'", () => {
  const tool = createSubagentTool();
  assert.equal(tool.name, "subagent");
  assert.equal(tool.label, "Subagent");
});
test("createSubagentTool exposes parameters, execute, promptSnippet, executionMode", () => {
  const tool = createSubagentTool();
  assert.ok(tool.parameters, "parameters schema defined");
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.promptSnippet?.toLowerCase().includes("subagent"));
  // ticket 10: sequential enforces "parallel fan-out goes through workflow.parallel()"
  // (workflow's parallel()/agent() dispatch via a separate createAgentSession path,
  //  so this does not throttle workflow fan-out).
  assert.equal(tool.executionMode, "sequential");
});

// ── execute maps params → spawn (success) ──
test("execute maps params to spawn and returns the child output verbatim", async () => {
  const f = fakeSpawn(() => ({ output: "Status: DONE\n- 1/1 passing", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute(
    "id",
    { task: "do X", model: "anthropic/claude-sonnet-4", tools: ["read"], agent: "implementer" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls[0]?.task, "do X");
  assert.equal(f.calls[0]?.model, "anthropic/claude-sonnet-4");
  assert.deepEqual(f.calls[0]?.tools, ["read"]);
  assert.equal(f.calls[0]?.instructions, "You are the implementer for this task.");
  assert.equal((res.content[0] as { text: string }).text, "Status: DONE\n- 1/1 passing");
  assert.equal(res.details.exitCode, 0);
  assert.equal(res.details.timedOut, false);
});

// ── failure / timeout formatting ──
test("execute on non-zero exit returns 'failed' + stderr text and keeps details", async () => {
  const f = fakeSpawn(() => ({ output: "", exitCode: 1, stderr: "hard fail", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /failed/);
  assert.match(text, /hard fail/);
  assert.equal(res.details.exitCode, 1);
  assert.equal(res.details.timedOut, false);
});
test("execute on timeout surfaces 'timed out', partial output, and details.timedOut=true", async () => {
  const f = fakeSpawn(() => ({ output: "partial", exitCode: 124, stderr: "", timedOut: true }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /timed out/);
  assert.match(text, /partial/);
  assert.equal(res.details.timedOut, true);
});
test("formatSubagentResult success returns output verbatim", () => {
  assert.equal(formatSubagentResult({ output: "ok", exitCode: 0, stderr: "x", timedOut: false }), "ok");
});

// ── extensionTools forwarding ──
test("execute forwards getExtensionTools() into spawn.extensionTools", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const fakeTools = [{ name: "read" }] as never;
  const tool = createSubagentTool({ spawn: f.spawn, getExtensionTools: () => fakeTools });
  await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.extensionTools, fakeTools, "same array ref forwarded");
});

// ── additional coverage (post-merge review follow-up) ──
test("execute forwards params.cwd override (wins over factory defaultCwd)", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, cwd: "/factory-cwd" });
  await tool.execute("id", { task: "t", cwd: "/explicit-cwd" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.cwd, "/explicit-cwd");
});
test("execute forwards excludeTools to spawn", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t", excludeTools: ["edit", "write"] }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(f.calls[0]?.excludeTools, ["edit", "write"]);
});
test("execute with no agent → instructions undefined (no role prefix)", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.instructions, undefined);
});
test("execute forwards getExtensionTools() === undefined when holder unset", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, getExtensionTools: () => undefined });
  await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.extensionTools, undefined);
});

test("execute forwards the runtime abort signal to spawn as externalSignal", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const controller = new AbortController();
  await tool.execute("id", { task: "t" }, controller.signal, undefined, NO_CTX);
  assert.equal(f.calls[0]?.externalSignal, controller.signal, "the tool-call signal must reach spawn()");
});

test("execute forwards timeoutMs/retryOnTransient to spawn", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t", timeoutMs: 5000, retryOnTransient: false }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.timeoutMs, 5000);
  assert.equal(f.calls[0]?.retryOnTransient, false);
});

// ── tier / mainModel / resolved-model (D: model-selection fix) ──
test("execute forwards params.tier to spawn", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t", tier: "small" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tier, "small");
  assert.equal(f.calls[0]?.model, undefined, "no explicit model when only tier is set");
});

test("execute forwards getMainModel() into spawn.mainModel", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, getMainModel: () => "deepseek/deepseek-v4-flash" });
  await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.mainModel, "deepseek/deepseek-v4-flash");
});

test("details.model reflects the resolved model id (onModelResolved wins over requested)", async () => {
  const f = fakeSpawn((opts) => {
    opts.onModelResolved?.("deepseek/deepseek-v4-flash");
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  });
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.model, "deepseek/deepseek-v4-flash", "TUI shows what actually ran, not 'default'");
});

test("details.model falls back to the live session model when the runner never resolves", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, getMainModel: () => "deepseek/deepseek-v4-flash" });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.model, "deepseek/deepseek-v4-flash", "omitted model → live session model shown");
});

test("agentType resolves tier from the registry when the call omits it", async () => {
  const registry = mkRegistry([{ name: "scout", tier: "small", prompt: "Be quick.", source: "project" }]);
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, agentRegistry: registry });
  await tool.execute("id", { task: "scan", agentType: "scout" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tier, "small");
});

// ── agentType binding + worktree isolation ──
test("agentType resolves tools/model/prompt from the registry when the call omits them", async () => {
  const registry = mkRegistry([
    {
      name: "security-auditor",
      tools: ["read", "grep"],
      disallowedTools: ["write"],
      model: "openai/gpt-4.1",
      prompt: "You are a security auditor. Be thorough.",
      source: "project",
    },
  ]);
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, agentRegistry: registry });
  await tool.execute("id", { task: "audit this", agentType: "security-auditor" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(f.calls[0]?.tools, ["read", "grep"]);
  assert.deepEqual(f.calls[0]?.excludeTools, ["write"]);
  assert.equal(f.calls[0]?.model, "openai/gpt-4.1");
  assert.ok((f.calls[0]?.instructions ?? "").includes("You are a security auditor. Be thorough."));
});

test("agentType: explicit params.model/tools/excludeTools override the binding", async () => {
  const registry = mkRegistry([
    { name: "security-auditor", tools: ["read"], model: "openai/gpt-4.1", prompt: "Be thorough.", source: "project" },
  ]);
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, agentRegistry: registry });
  await tool.execute(
    "id",
    { task: "audit this", agentType: "security-auditor", model: "anthropic/claude-sonnet-4", tools: ["read", "bash"] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls[0]?.model, "anthropic/claude-sonnet-4", "explicit model wins");
  assert.deepEqual(f.calls[0]?.tools, ["read", "bash"], "explicit tools win");
});

test("unknown agentType returns a tool-level error listing available names, without calling spawn", async () => {
  const registry = mkRegistry([{ name: "reviewer", prompt: "Review.", source: "project" }]);
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, agentRegistry: registry });
  const res = await tool.execute("id", { task: "t", agentType: "nope" }, NO_SIGNAL, undefined, NO_CTX);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /Unknown agentType "nope"/);
  assert.match(text, /reviewer/);
  assert.equal(f.calls.length, 0, "spawn is never called for an unresolvable agentType");
  assert.equal(res.details.status, "failed");
});

test("agentType with isolation:'worktree' passes the worktree cwd to spawn", async () => {
  const registry = mkRegistry([
    { name: "isolated-worker", isolation: "worktree", prompt: "Work in isolation.", source: "project" },
  ]);
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const fakeWorktree = { createCalls: [] as Array<{ baseCwd: string; name: string }>, removeCalls: 0 };
  const tool = createSubagentTool({
    spawn: f.spawn,
    agentRegistry: registry,
    cwd: "/repo",
    createWorktree: async (baseCwd: string, name: string) => {
      fakeWorktree.createCalls.push({ baseCwd, name });
      return {
        isolated: true,
        cwd: "/repo/.pi/worktrees/isolated-worker",
        repoRoot: "/repo",
        branch: "pi/wf/isolated-worker",
      };
    },
    removeWorktree: async () => {
      fakeWorktree.removeCalls++;
    },
  });
  await tool.execute("id", { task: "t", agentType: "isolated-worker" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.cwd, "/repo/.pi/worktrees/isolated-worker");
  assert.equal(fakeWorktree.createCalls.length, 1);
  assert.equal(fakeWorktree.removeCalls, 1, "worktree is cleaned up after the run");
});

test("agentType with isolation:'worktree' falls back to runCwd when createWorktree reports isolated:false", async () => {
  const registry = mkRegistry([
    { name: "isolated-worker", isolation: "worktree", prompt: "Work in isolation.", source: "project" },
  ]);
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const fakeWorktree = { createCalls: 0, removeCalls: 0 };
  const tool = createSubagentTool({
    spawn: f.spawn,
    agentRegistry: registry,
    cwd: "/repo",
    createWorktree: async () => {
      fakeWorktree.createCalls++;
      return { isolated: false, cwd: "/repo", reason: "not a git repository" };
    },
    removeWorktree: async () => {
      fakeWorktree.removeCalls++;
    },
  });
  await tool.execute("id", { task: "t", agentType: "isolated-worker" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.cwd, "/repo", "spawn still runs, using the original cwd");
  assert.equal(fakeWorktree.createCalls, 1);
  assert.equal(fakeWorktree.removeCalls, 1, "teardown is still invoked even for a no-op worktree");
});

test("schema is forwarded to spawn unchanged", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const f = fakeSpawn(() => ({ output: '{"ok":true}', exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t", schema }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(f.calls[0]?.schema, schema);
});

test("malformed schema (not an object, or missing 'type') is rejected before spawn is called", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });

  const res1 = await tool.execute("id", { task: "t", schema: "not an object" as never }, NO_SIGNAL, undefined, NO_CTX);
  assert.match((res1.content[0] as { text: string }).text, /Invalid schema/);

  const res2 = await tool.execute(
    "id",
    { task: "t", schema: { properties: {} } as never },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.match((res2.content[0] as { text: string }).text, /Invalid schema/);

  assert.equal(f.calls.length, 0, "spawn is never called for a malformed schema");
});

test("execute wires onHistory to _onUpdate as a partial content update", async () => {
  const fixtureHistory = [{ role: "assistant" as const, kind: "toolCall" as const, toolName: "read", text: "{}" }];
  const f = fakeSpawn(async (opts) => {
    (opts.onHistory as ((h: typeof fixtureHistory) => void) | undefined)?.(fixtureHistory);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  });
  const tool = createSubagentTool({ spawn: f.spawn });
  const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
  await tool.execute("id", { task: "t" }, NO_SIGNAL, (u) => updates.push(u as never), NO_CTX);
  assert.equal(updates.length, 1);
  assert.match((updates[0]?.content[0] as { text: string }).text, /read/);
  assert.equal(updates[0]?.details, undefined, "partial updates carry no details yet, per the SDK contract");
});

test("execute passes no onHistory to spawn when the caller gave no _onUpdate", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.onHistory, undefined);
});

test("a throwing _onUpdate does not fail the subagent run (caught and swallowed)", async () => {
  const fixtureHistory = [{ role: "assistant" as const, kind: "toolCall" as const, toolName: "read", text: "{}" }];
  const f = fakeSpawn(async (opts) => {
    (opts.onHistory as ((h: typeof fixtureHistory) => void) | undefined)?.(fixtureHistory);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  });
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute(
    "id",
    { task: "t" },
    NO_SIGNAL,
    () => {
      throw new Error("TUI re-render blew up");
    },
    NO_CTX,
  );
  assert.equal(res.details.status, "done", "the throwing onUpdate must not fail the actual task result");
});

test("live progress: displayed tool-call count never regresses across a retryOnTransient retry", async () => {
  // spawnSubagent's retryOnTransient retry runs a brand-new child session on
  // attempt 2 (agent.ts), so the AgentHistoryEntry[] snapshot onHistory sees
  // resets to a shorter array. Simulate that here: attempt 1 reports 3
  // toolCall entries (then "times out"); attempt 2 reports only 1 entry
  // before succeeding. The number shown to the user must never drop.
  const attempt1History = [
    { role: "assistant" as const, kind: "toolCall" as const, toolName: "read", text: "{}" },
    { role: "assistant" as const, kind: "toolCall" as const, toolName: "grep", text: "{}" },
    { role: "assistant" as const, kind: "toolCall" as const, toolName: "ls", text: "{}" },
  ];
  const attempt2History = [{ role: "assistant" as const, kind: "toolCall" as const, toolName: "read", text: "{}" }];
  const f = fakeSpawn(async (opts) => {
    const onHistory = opts.onHistory as ((h: typeof attempt1History) => void) | undefined;
    onHistory?.(attempt1History);
    onHistory?.(attempt2History);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  });
  const tool = createSubagentTool({ spawn: f.spawn });
  const updates: Array<{ content: Array<{ type: string; text?: string }> }> = [];
  await tool.execute("id", { task: "t", retryOnTransient: true }, NO_SIGNAL, (u) => updates.push(u as never), NO_CTX);

  assert.equal(updates.length, 2);
  const toolCallCounts = updates.map((u) => {
    const text = (u.content[0] as { text: string }).text;
    const m = text.match(/(\d+) tool calls?/);
    return m ? Number(m[1]) : -1;
  });
  assert.deepEqual(
    toolCallCounts,
    [3, 3],
    "the retry's shorter history (1 entry) must not drag the displayed count back down from 3",
  );
});

test("renderSubagentResult with isPartial:true renders the streamed text, ignoring details", () => {
  const out = renderSubagentResult(
    { content: [{ type: "text", text: "↳ reading src/foo.ts" }], details: undefined },
    { expanded: false, isPartial: true },
    T,
  );
  assert.equal(out, "↳ reading src/foo.ts");
});

test("execute carries usage from the spawn result into details", async () => {
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.001 };
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false, usage }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(res.details.usage, usage);
});

// ── details enrichment (renderResult + /subagents data source) ──
test("execute enriches details with agent/model/taskPreview/elapsedMs/status for a done run", async () => {
  const f = fakeSpawn(() => ({ output: "Status: DONE", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute(
    "id",
    { task: "do something\nwith newlines   and spaces", agent: "implementer", model: "x/flash" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const d = res.details;
  assert.equal(d.status, "done");
  assert.equal(d.agent, "implementer");
  assert.equal(d.model, "x/flash");
  assert.equal(d.exitCode, 0);
  assert.ok(d.elapsedMs >= 0, "elapsedMs recorded");
  assert.ok(!d.taskPreview.includes("\n"), "taskPreview is single-line");
  assert.ok(d.taskPreview.length <= 80, "taskPreview bounded to 80");
});

test("execute defaults model to 'default' and omits agent when absent", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.model, "default");
  assert.equal(res.details.agent, undefined);
});

test("execute reports status 'timedout' and 'failed' from the spawn result", async () => {
  const t = createSubagentTool({
    spawn: fakeSpawn(() => ({ output: "", exitCode: 124, stderr: "x", timedOut: true })).spawn,
  });
  const rt = await t.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(rt.details.status, "timedout");
  const f = createSubagentTool({
    spawn: fakeSpawn(() => ({ output: "", exitCode: 1, stderr: "boom", timedOut: false })).spawn,
  });
  const rf = await f.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(rf.details.status, "failed");
});

test("deriveSubagentStatus + taskPreview helpers", () => {
  assert.equal(deriveSubagentStatus({ output: "", exitCode: 0, stderr: "", timedOut: false }), "done");
  assert.equal(deriveSubagentStatus({ output: "", exitCode: 1, stderr: "", timedOut: false }), "failed");
  assert.equal(deriveSubagentStatus({ output: "", exitCode: 124, stderr: "", timedOut: true }), "timedout");
  assert.equal(taskPreview("hello"), "hello");
  const long = "x".repeat(120);
  assert.equal(taskPreview(long).length, 80);
  assert.ok(taskPreview(long).endsWith("…"));
  assert.equal(taskPreview("a\n b\n  c"), "a b c");
});

// ── formatSubagentProgress (onHistory → progress-line rendering) ──
test("formatSubagentProgress on empty history shows the '…' placeholder", () => {
  const out = formatSubagentProgress([], 0);
  assert.match(out, /…/);
});

test("formatSubagentProgress toolCall entry includes the tool name", () => {
  const history: AgentHistoryEntry[] = [{ role: "assistant", kind: "toolCall", toolName: "grep", text: "{}" }];
  const out = formatSubagentProgress(history, 1000);
  assert.match(out, /grep/);
});

test("formatSubagentProgress toolResult entry includes '→ done'", () => {
  const history: AgentHistoryEntry[] = [{ role: "tool", kind: "toolResult", toolName: "read", text: "contents" }];
  const out = formatSubagentProgress(history, 1000);
  assert.match(out, /read → done/);
});

test("formatSubagentProgress text entry includes the (truncated) first line", () => {
  const history: AgentHistoryEntry[] = [
    { role: "assistant", kind: "text", text: "Investigating the failure\nmore detail" },
  ];
  const out = formatSubagentProgress(history, 1000);
  assert.match(out, /Investigating the failure/);
  assert.ok(!out.includes("more detail"), "only the first line is shown");
});

test("formatSubagentProgress error entry is marked distinctly (not indistinguishable from plain text)", () => {
  const history: AgentHistoryEntry[] = [
    { role: "tool", kind: "error", toolName: "bash", text: "command not found: foo", isError: true },
  ];
  const out = formatSubagentProgress(history, 1000);
  assert.match(out, /⚠/, "error entries carry a distinct marker");
  assert.match(out, /command not found: foo/);
});

test("formatSubagentProgress pluralizes the tool-call count (1 vs N)", () => {
  const one: AgentHistoryEntry[] = [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }];
  const two: AgentHistoryEntry[] = [
    { role: "assistant", kind: "toolCall", toolName: "read", text: "{}" },
    { role: "assistant", kind: "toolCall", toolName: "grep", text: "{}" },
  ];
  assert.match(formatSubagentProgress(one, 0), /1 tool call(?!s)/);
  assert.match(formatSubagentProgress(two, 0), /2 tool calls/);
});

test("formatSubagentProgress includes elapsed seconds", () => {
  const out = formatSubagentProgress([], 12300);
  assert.match(out, /12\.3s/);
});

test("formatSubagentProgress's minToolCalls floors the displayed count without going below the actual count", () => {
  const oneCall: AgentHistoryEntry[] = [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }];
  assert.match(formatSubagentProgress(oneCall, 0, 3), /3 tool calls/, "floor wins when history reports fewer");
  const threeCalls: AgentHistoryEntry[] = [
    { role: "assistant", kind: "toolCall", toolName: "a", text: "{}" },
    { role: "assistant", kind: "toolCall", toolName: "b", text: "{}" },
    { role: "assistant", kind: "toolCall", toolName: "c", text: "{}" },
  ];
  assert.match(formatSubagentProgress(threeCalls, 0, 1), /3 tool calls/, "actual count wins when it exceeds the floor");
});

// ── renderCall / renderResult (pure helpers, themed strings) ──
// Identity theme so assertions see plain text.
const T = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as never;

test("renderSubagentCall shows subagent ▸ agent ▸ model ▸ task (omits agent when absent)", () => {
  const withRole = renderSubagentCall({ task: "fix the bug", agent: "implementer", model: "x/flash" }, T);
  assert.ok(withRole.includes("subagent"));
  assert.ok(withRole.includes("implementer"));
  assert.ok(withRole.includes("x/flash"));
  assert.ok(withRole.includes("fix the bug"));
  const noRole = renderSubagentCall({ task: "explore" }, T);
  assert.ok(noRole.includes("subagent"));
  assert.ok(!noRole.includes("▸ implementer"));
  assert.ok(noRole.includes("default")); // model defaults to "default" when undefined
});

test("renderSubagentCall shows 'tier:small' in the model slot when model is omitted", () => {
  const out = renderSubagentCall({ agent: "scout", tier: "small", task: "x" }, T);
  assert.match(out, /tier:small/);
  assert.doesNotMatch(out, /default/);
});

test("renderSubagentCall appends resolved model as a separate segment when tier is shown", () => {
  const out = renderSubagentCall(
    { agent: "auditor", tier: "medium", task: "x", resolvedModel: "google/gemma-4-12b-qat" },
    T,
  );
  assert.match(out, /tier:medium ▸ google\/gemma-4-12b-qat ▸/);
});

test("renderSubagentCall omits resolved model before resolution (undefined)", () => {
  const out = renderSubagentCall({ agent: "auditor", tier: "medium", task: "x" }, T);
  assert.match(out, /tier:medium/);
  assert.doesNotMatch(out, /google/);
});

test("renderSubagentCall omits resolved model when it equals the explicit model slot (no dup)", () => {
  const out = renderSubagentCall(
    { agent: "scout", model: "x/flash", task: "x", resolvedModel: "x/flash" },
    T,
  );
  assert.equal((out.match(/x\/flash/g) || []).length, 1);
});

test("renderSubagentResult collapsed is short; expanded contains the full report", () => {
  const details: SubagentToolDetails = {
    exitCode: 0,
    timedOut: false,
    agent: "implementer",
    model: "x/flash",
    taskPreview: "p",
    elapsedMs: 12350,
    status: "done",
  };
  const full = "Line one of report\nLine two of report\nLine three";
  const collapsed = renderSubagentResult({ content: [{ type: "text", text: full }], details }, { expanded: false }, T);
  const expanded = renderSubagentResult({ content: [{ type: "text", text: full }], details }, { expanded: true }, T);
  assert.ok(collapsed.length < expanded.length, "collapsed is shorter");
  assert.ok(collapsed.includes("done"));
  assert.ok(collapsed.includes("Line one of report"));
  assert.ok(!collapsed.includes("Line three"), "collapsed drops later lines");
  assert.ok(expanded.includes("Line one of report"));
  assert.ok(expanded.includes("Line three"), "expanded keeps everything");
  assert.ok(expanded.includes("12.3s") || expanded.includes("12."), "expanded shows elapsed seconds");
});

test("renderSubagentResult shows cost/tokens when usage.total > 0, omits when 0 or absent", () => {
  const base: Omit<SubagentToolDetails, "usage"> = {
    exitCode: 0,
    timedOut: false,
    taskPreview: "p",
    elapsedMs: 1000,
    status: "done",
  };
  const withUsage = renderSubagentResult(
    {
      content: [{ type: "text", text: "ok" }],
      details: { ...base, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 0.0023 } },
    },
    { expanded: false },
    T,
  );
  assert.ok(withUsage.includes("$0.002"), "shows cost to 3 decimals");
  assert.ok(withUsage.includes("150 tok"), "shows total tokens");

  const zeroUsage = renderSubagentResult(
    {
      content: [{ type: "text", text: "ok" }],
      details: { ...base, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 } },
    },
    { expanded: false },
    T,
  );
  assert.ok(!zeroUsage.includes("$"), "omits cost when total usage is 0");

  const noUsage = renderSubagentResult(
    { content: [{ type: "text", text: "ok" }], details: base as SubagentToolDetails },
    { expanded: false },
    T,
  );
  assert.ok(!noUsage.includes("$"), "omits cost when usage is absent entirely");
});

test("renderSubagentResult failed/timedout badges + missing-details fallback", () => {
  const failStr = renderSubagentResult(
    {
      content: [{ type: "text", text: "err" }],
      details: { exitCode: 1, timedOut: false, taskPreview: "p", elapsedMs: 0, status: "failed" },
    },
    { expanded: false },
    T,
  );
  assert.ok(failStr.includes("failed"));
  const toStr = renderSubagentResult(
    {
      content: [{ type: "text", text: "err" }],
      details: { exitCode: 124, timedOut: true, taskPreview: "p", elapsedMs: 0, status: "timedout" },
    },
    { expanded: false },
    T,
  );
  assert.ok(toStr.includes("timedout"));
  // No details → just the raw text
  assert.equal(renderSubagentResult({ content: [{ type: "text", text: "raw" }] }, { expanded: false }, T), "raw");
});

// ── Part A: Ctrl-O live output (formatSubagentLive + isPartial expanded) ──

test("formatSubagentLive includes the progress header (elapsed + tool-call count)", () => {
  const history: AgentHistoryEntry[] = [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }];
  const out = formatSubagentLive(history, 5500);
  assert.match(out, /5\.5s/);
  assert.match(out, /1 tool call/);
});

test("formatSubagentLive includes a trace line per recent history entry", () => {
  const history: AgentHistoryEntry[] = [
    { role: "assistant", kind: "toolCall", toolName: "read", text: "{}" },
    { role: "tool", kind: "toolResult", toolName: "read", text: "contents" },
    { role: "assistant", kind: "toolCall", toolName: "grep", text: "{}" },
  ];
  const out = formatSubagentLive(history, 1000);
  assert.match(out, /→ read/);
  assert.match(out, /← read/);
  assert.match(out, /→ grep/);
});

test("formatSubagentLive surfaces a truncated tool-arg/result preview on each trace line (debug visibility)", () => {
  // compactAgentHistory already captures tool-call arguments (as a compact JSON
  // string) and tool-result text into `text`. The trace line must surface a
  // short slice of each so the expanded view reads as a transcript.
  const history: AgentHistoryEntry[] = [
    { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/foo.ts"}' },
    { role: "tool", kind: "toolResult", toolName: "read", text: "export const x = 1;" },
  ];
  const out = formatSubagentLive(history, 1000);
  assert.match(out, /→ read.*src\/foo\.ts/, "tool-call arguments are surfaced on the trace line");
  assert.match(out, /← read.*export const x/, "tool-result text is surfaced on the trace line");
});

test("formatSubagentLive leaves a bare `{}` arg payload off the trace line (no noise)", () => {
  // An empty-args tool call renders as a clean `→ name` marker — the `{}` adds
  // no information and would clutter the trace.
  const history: AgentHistoryEntry[] = [{ role: "assistant", kind: "toolCall", toolName: "ls", text: "{}" }];
  const out = formatSubagentLive(history, 0);
  assert.match(out, /→ ls$/m, "bare {} args are not appended");
});

test("formatSubagentLive caps the trace at maxTraceLines (default 100)", () => {
  const history: AgentHistoryEntry[] = Array.from({ length: 150 }, (_, i) => ({
    role: "assistant" as const,
    kind: "toolCall" as const,
    toolName: `t${i}`,
    text: "{}",
  }));
  const out = formatSubagentLive(history, 0);
  const lines = out.split("\n");
  assert.ok(lines.length <= 102, `trace capped at 100 lines (+2 header); got ${lines.length}`);
  assert.match(out, /t149/, "the most recent entry is retained");
  assert.ok(!out.includes("t0"), "entries older than the cap are dropped");
});

test("renderSubagentResult isPartial+collapsed shows ≤2 header lines; expanded shows the trace (ctrl-o)", () => {
  const text = formatSubagentLive(
    [
      { role: "assistant", kind: "toolCall", toolName: "read", text: "{}" },
      { role: "tool", kind: "toolResult", toolName: "read", text: "x" },
    ],
    2000,
  );
  const collapsed = renderSubagentResult(
    { content: [{ type: "text", text }] },
    { expanded: false, isPartial: true },
    T,
  );
  const expanded = renderSubagentResult({ content: [{ type: "text", text }] }, { expanded: true, isPartial: true }, T);
  assert.ok(collapsed.split("\n").length <= 2, "collapsed shows at most the 2-line header");
  assert.ok(expanded.split("\n").length > collapsed.split("\n").length, "expanded shows the trace too");
  assert.match(expanded, /→ read/);
  assert.match(expanded, /← read/);
  assert.ok(!collapsed.includes("← read"), "collapsed hides the trace");
});

test("renderSubagentResult isPartial preserves a plain streamed line when collapsed (backward-compat)", () => {
  // The pre-Part-A behavior returned the streamed text verbatim (dim). A
  // single-line payload must still render as that single line when collapsed.
  const out = renderSubagentResult(
    { content: [{ type: "text", text: "↳ reading src/foo.ts" }] },
    { expanded: false, isPartial: true },
    T,
  );
  assert.equal(out, "↳ reading src/foo.ts");
});

// ── Part B: in-flight registry wiring ──

test("execute registers on inFlight at start, streams history, deregisters on completion", async () => {
  const reg = new SubagentInFlightRegistry();
  let resolveSpawn: (r: SpawnSubagentResult) => void = () => {};
  const f = fakeSpawn(
    (_opts) =>
      new Promise<SpawnSubagentResult>((res) => {
        resolveSpawn = res;
      }),
  );
  const tool = createSubagentTool({ spawn: f.spawn, inFlight: reg });
  const p = tool.execute(
    "id-7",
    { task: "do work", agent: "implementer", model: "x/flash" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  await Promise.resolve(); // reach the registered-but-pending window
  assert.equal(reg.list().length, 1, "registered while in flight");
  assert.equal(reg.list()[0].id, "id-7");
  assert.equal(reg.list()[0].agent, "implementer");
  assert.equal(reg.list()[0].model, "x/flash");
  // history streams through onHistory → registry.update
  (f.calls[0]?.onHistory as ((h: never[]) => void) | undefined)?.([
    { role: "assistant", kind: "toolCall", toolName: "read", text: "{}" },
  ] as never);
  assert.equal(reg.list()[0].history?.[0]?.toolName, "read");
  // complete → deregistered
  resolveSpawn({ output: "ok", exitCode: 0, stderr: "", timedOut: false });
  await p;
  assert.equal(reg.list().length, 0, "deregistered after completion");
});

test("execute deregisters from inFlight even on failure", async () => {
  const reg = new SubagentInFlightRegistry();
  const f = fakeSpawn(() => ({ output: "", exitCode: 1, stderr: "boom", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, inFlight: reg });
  await tool.execute("id-8", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(reg.list().length, 0, "deregistered even after a failed run");
});

// ── persistence hook (ticket 08): durable record per completed run ──

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

test("execute persists a durable record on completion (done), carrying the compact transcript", async () => {
  const { saved, persistence } = fakePersistence();
  const f = fakeSpawn((opts) => {
    opts.onHistory?.([{ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"x"}' }]);
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  });
  const tool = createSubagentTool({ spawn: f.spawn, persistence, cwd: "/repo" });
  await tool.execute("id-p1", { task: "do work", agent: "implementer" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(saved.length, 1, "one record saved");
  const rec = saved[0];
  assert.equal(rec.status, "done");
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.output, "ok");
  assert.equal(rec.agent, "implementer");
  assert.equal(rec.cwd, "/repo");
  assert.equal(rec.toolCallId, "id-p1");
  assert.equal(rec.history?.[0]?.toolName, "read", "compact transcript captured for replay");
  assert.match(rec.startedAt, /^\d{4}-\d{2}-\d{2}T/, "startedAt is ISO");
});

test("execute persists a record on failure too (failed runs are worth inspecting)", async () => {
  const { saved, persistence } = fakePersistence();
  const f = fakeSpawn(() => ({ output: "", exitCode: 1, stderr: "boom", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id-p2", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, "failed");
  assert.equal(saved[0].stderr, "boom");
});

test("execute does NOT persist on a pre-flight failure (invalid schema is not a real run)", async () => {
  const { saved, persistence } = fakePersistence();
  const f = fakeSpawn(() => ({ output: "x", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id-p3", { task: "t", schema: "not-schema-shaped" as never }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(saved.length, 0, "pre-flight rejection must not create a run record");
});

// ── commitScope guardrail (git-scope integration) ──

/**
 * Fake git ops for the commitScope guardrail. headCommit is called twice per
 * checked run — call 1 (pre-dispatch) returns `baseHead`; call 2 (post-run,
 * inside computeScopeCheck) returns `postHead`. changedPaths returns `paths`.
 */
function fakeGitOps(opts: { baseHead?: string; postHead?: string; paths?: string[] }) {
  const calls = {
    headCwds: [] as string[],
    changed: [] as Array<{ cwd: string; base: string; head: string }>,
  };
  const ops: GitScopeOps = {
    async headCommit(cwd: string) {
      calls.headCwds.push(cwd);
      return calls.headCwds.length === 1 ? opts.baseHead : opts.postHead;
    },
    async changedPaths(cwd: string, base: string, head: string) {
      calls.changed.push({ cwd, base, head });
      return opts.paths ?? [];
    },
  };
  return { calls, ops };
}

test("commitScope unset → no git ops called, details.scopeCheck undefined", async () => {
  const { calls, ops } = fakeGitOps({ baseHead: "b1", postHead: "b1" });
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, gitOps: ops, cwd: "/repo" });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.scopeCheck, undefined);
  assert.equal(calls.headCwds.length, 0, "headCommit never invoked without commitScope");
});

test("commitScope set, all touched in scope → scopeCheck present, outOfScope empty, output clean", async () => {
  const { calls, ops } = fakeGitOps({ baseHead: "b1", postHead: "h2", paths: ["src/a.ts", "src/sub/b.ts"] });
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, gitOps: ops, cwd: "/repo" });
  const res = await tool.execute("id", { task: "t", commitScope: ["src/"] }, NO_SIGNAL, undefined, NO_CTX);
  const sc = res.details.scopeCheck;
  assert.ok(sc, "scopeCheck present");
  assert.deepEqual(sc?.touchedPaths, ["src/a.ts", "src/sub/b.ts"]);
  assert.deepEqual(sc?.outOfScope, []);
  assert.equal(sc?.baseCommit, "b1");
  assert.equal(sc?.headCommit, "h2");
  assert.deepEqual(calls.changed, [{ cwd: "/repo", base: "b1", head: "h2" }]);
  assert.ok(!(res.content[0] as { text: string }).text.includes("commit-scope violation"), "no warning when in scope");
});

test("commitScope set, out-of-scope paths → ⚠ block appended to output + details.outOfScope", async () => {
  const { ops } = fakeGitOps({
    baseHead: "b1",
    postHead: "h2",
    paths: ["src/a.ts", "README.md", ".planning/stub.md"],
  });
  const f = fakeSpawn(() => ({ output: "Status: DONE", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, gitOps: ops, cwd: "/repo" });
  const res = await tool.execute("id", { task: "fix it", commitScope: ["src/"] }, NO_SIGNAL, undefined, NO_CTX);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /⚠ commit-scope violation/);
  assert.match(text, /README\.md/);
  assert.match(text, /\.planning\/stub\.md/);
  assert.deepEqual(res.details.scopeCheck?.outOfScope, ["README.md", ".planning/stub.md"]);
});

test("commitScope: [] flags ANY committed path (read-only guard)", async () => {
  const { ops } = fakeGitOps({ baseHead: "b1", postHead: "h2", paths: ["src/a.ts"] });
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, gitOps: ops, cwd: "/repo" });
  const res = await tool.execute("id", { task: "t", commitScope: [] }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(res.details.scopeCheck?.outOfScope, ["src/a.ts"]);
  assert.match((res.content[0] as { text: string }).text, /commit-scope violation/);
});

test("commitScope set but child committed nothing (base === head) → empty, no violation, no diff call", async () => {
  const { calls, ops } = fakeGitOps({ baseHead: "same", postHead: "same" });
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, gitOps: ops, cwd: "/repo" });
  const res = await tool.execute("id", { task: "t", commitScope: ["src/"] }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(res.details.scopeCheck?.touchedPaths, []);
  assert.deepEqual(res.details.scopeCheck?.outOfScope, []);
  assert.equal(calls.changed.length, 0, "changedPaths skipped when base === head");
});

test("commitScope ignored for worktree-isolated runs (their commits are discarded anyway)", async () => {
  const registry = mkRegistry([
    { name: "isolated-worker", isolation: "worktree", prompt: "Work in isolation.", source: "project" },
  ]);
  const { calls, ops } = fakeGitOps({ baseHead: "b1", postHead: "h2", paths: ["src/a.ts"] });
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({
    spawn: f.spawn,
    gitOps: ops,
    agentRegistry: registry,
    cwd: "/repo",
    createWorktree: async () => ({
      isolated: true,
      cwd: "/repo/.pi/worktrees/x",
      repoRoot: "/repo",
      branch: "pi/wf/x",
    }),
    removeWorktree: async () => {},
  });
  const res = await tool.execute(
    "id",
    { task: "t", agentType: "isolated-worker", commitScope: ["src/"] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(res.details.scopeCheck, undefined, "worktree-isolated run is not scope-checked");
  assert.equal(calls.headCwds.length, 0, "no git ops for an isolated run");
});

test("commitScope set but not a repo (headCommit undefined before dispatch) → scopeCheck undefined", async () => {
  const { calls, ops } = fakeGitOps({ baseHead: undefined, postHead: "h2" });
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, gitOps: ops, cwd: "/repo" });
  const res = await tool.execute("id", { task: "t", commitScope: ["src/"] }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.scopeCheck, undefined);
  assert.equal(calls.changed.length, 0, "no post-run diff when base could not resolve");
});

test("renderSubagentResult tints out-of-scope count as a warning (separate axis from status/SDD)", () => {
  const details: SubagentToolDetails = {
    exitCode: 0,
    timedOut: false,
    taskPreview: "p",
    elapsedMs: 1000,
    status: "done",
    scopeCheck: {
      baseCommit: "b",
      headCommit: "h",
      touchedPaths: ["x.ts", ".planning/y.md"],
      outOfScope: [".planning/y.md"],
    },
  };
  const out = renderSubagentResult({ content: [{ type: "text", text: "ok" }], details }, { expanded: false }, T);
  assert.match(out, /1 out-of-scope/);
});

test("execute persists scopeCheck on the durable run record (for /subagents replay)", async () => {
  const { saved, persistence } = fakePersistence();
  const { ops } = fakeGitOps({ baseHead: "b1", postHead: "h2", paths: ["src/a.ts", "README.md"] });
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, gitOps: ops, persistence, cwd: "/repo" });
  await tool.execute("id", { task: "t", commitScope: ["src/"] }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].scopeCheck?.outOfScope, ["README.md"], "violation persisted for replay");
});

// ── tokenBudget/spendBudget (budget cap) ──

test("execute forwards tokenBudget/spendBudget to spawn", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t", tokenBudget: 5000, spendBudget: 0.25 }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tokenBudget, 5000);
  assert.equal(f.calls[0]?.spendBudget, 0.25);
});

test("spawn result with budget → status 'budget', details.budget, distinct output", async () => {
  const f = fakeSpawn(() => ({
    output: "",
    exitCode: 1,
    stderr: "",
    timedOut: false,
    budget: { kind: "tokens", limit: 1000, actual: 1234 },
  }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t", tokenBudget: 1000 }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.status, "budget");
  assert.deepEqual(res.details.budget, { kind: "tokens", limit: 1000, actual: 1234 });
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /budget exhausted/);
  assert.match(text, /1234 tokens/);
});

test("renderSubagentResult renders a budget badge + budgetTag", () => {
  const details: SubagentToolDetails = {
    exitCode: 1,
    timedOut: false,
    taskPreview: "p",
    elapsedMs: 1000,
    status: "budget",
    budget: { kind: "tokens", limit: 1000, actual: 1234 },
  };
  const out = renderSubagentResult({ content: [{ type: "text", text: "aborted" }], details }, { expanded: false }, T);
  assert.match(out, /budget/);
  assert.match(out, /tokens:1234\/1000/);
});

test("execute persists budget on the durable run record (status 'budget')", async () => {
  const { saved, persistence } = fakePersistence();
  const f = fakeSpawn(() => ({
    output: "",
    exitCode: 1,
    stderr: "",
    timedOut: false,
    budget: { kind: "spend", limit: 0.5, actual: 0.62 },
  }));
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id", { task: "t", spendBudget: 0.5 }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, "budget");
  assert.deepEqual(saved[0].budget, { kind: "spend", limit: 0.5, actual: 0.62 });
});

// ── schemaRepairAttempts (structured-output repair) ──

test("execute forwards schemaRepairAttempts to spawn", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t", schemaRepairAttempts: 4 }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.schemaRepairAttempts, 4);
});
