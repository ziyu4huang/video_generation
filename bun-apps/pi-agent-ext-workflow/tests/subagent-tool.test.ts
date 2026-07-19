import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createSubagentTool,
  deriveSubagentStatus,
  formatSubagentResult,
  renderSubagentCall,
  renderSubagentResult,
  taskPreview,
} from "../src/subagent-tool.js";
import type { SubagentToolDetails } from "../src/subagent-tool.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "../src/spawn-subagent.js";

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
