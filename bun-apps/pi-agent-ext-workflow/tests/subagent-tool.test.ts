import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createSubagentTool,
  deriveSubagentStatus,
  formatSubagentProgress,
  formatSubagentResult,
  renderSubagentCall,
  renderSubagentResult,
  taskPreview,
} from "../src/subagent-tool.js";
import type { SubagentToolDetails } from "../src/subagent-tool.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "../src/spawn-subagent.js";
import type { AgentHistoryEntry } from "../src/agent-history.js";

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
test("createSubagentTool exposes parameters, execute, promptSnippet", () => {
  const tool = createSubagentTool();
  assert.ok(tool.parameters, "parameters schema defined");
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.promptSnippet && tool.promptSnippet.toLowerCase().includes("subagent"));
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

  const res2 = await tool.execute("id", { task: "t", schema: { properties: {} } as never }, NO_SIGNAL, undefined, NO_CTX);
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
  await tool.execute(
    "id",
    { task: "t", retryOnTransient: true },
    NO_SIGNAL,
    (u) => updates.push(u as never),
    NO_CTX,
  );

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
  const t = createSubagentTool({ spawn: fakeSpawn(() => ({ output: "", exitCode: 124, stderr: "x", timedOut: true })).spawn });
  const rt = await t.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(rt.details.status, "timedout");
  const f = createSubagentTool({ spawn: fakeSpawn(() => ({ output: "", exitCode: 1, stderr: "boom", timedOut: false })).spawn });
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
  const history: AgentHistoryEntry[] = [{ role: "assistant", kind: "text", text: "Investigating the failure\nmore detail" }];
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

test("renderSubagentResult collapsed is short; expanded contains the full report", () => {
  const details: SubagentToolDetails = {
    exitCode: 0, timedOut: false, agent: "implementer", model: "x/flash",
    taskPreview: "p", elapsedMs: 12350, status: "done",
  };
  const full = "Line one of report\nLine two of report\nLine three";
  const collapsed = renderSubagentResult(
    { content: [{ type: "text", text: full }], details }, { expanded: false }, T,
  );
  const expanded = renderSubagentResult(
    { content: [{ type: "text", text: full }], details }, { expanded: true }, T,
  );
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
    exitCode: 0, timedOut: false, taskPreview: "p", elapsedMs: 1000, status: "done",
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
    { content: [{ type: "text", text: "err" }], details: { exitCode: 1, timedOut: false, taskPreview: "p", elapsedMs: 0, status: "failed" } },
    { expanded: false }, T,
  );
  assert.ok(failStr.includes("failed"));
  const toStr = renderSubagentResult(
    { content: [{ type: "text", text: "err" }], details: { exitCode: 124, timedOut: true, taskPreview: "p", elapsedMs: 0, status: "timedout" } },
    { expanded: false }, T,
  );
  assert.ok(toStr.includes("timedout"));
  // No details → just the raw text
  assert.equal(renderSubagentResult({ content: [{ type: "text", text: "raw" }] }, { expanded: false }, T), "raw");
});
