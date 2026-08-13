import { test } from "bun:test";
import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import type { AgentHistoryEntry } from "@repo/pi-agent-ext-core-runtime";
import { SubagentInFlightRegistry } from "@repo/pi-agent-ext-core-runtime";
import type { GitScopeOps } from "../src/git-scope.js";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "../src/spawn-subagent.js";
import type { SubagentRunPersistence, SubagentRunRecord } from "../src/subagent-run-persistence.js";
import { createSubagentTool } from "../src/subagent-tool.js";
import {
  deriveSubagentStatus,
  formatHistoryLine,
  formatSubagentLive,
  formatSubagentProgress,
  formatSubagentResult,
  formatSubagentTrace,
  latestMessageLine,
  renderSubagentCall,
  renderSubagentResult,
  taskPreview,
  workIntentPreview,
} from "../src/subagent-tool-render.js";
import type { SubagentToolDetails } from "../src/subagent-tool-schema.js";
import { DEFAULT_TIMEOUT_MS } from "../src/subagent-tool-schema.js";

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

import type { AgentDefinition, AgentRegistry } from "@repo/pi-agent-ext-core-runtime";

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

// ── default wall-clock timeout (DEFAULT_TIMEOUT_MS) ──
test("execute applies DEFAULT_TIMEOUT_MS when timeoutMs omitted", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test("execute honors explicit timeoutMs over the default", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t", timeoutMs: 5000 }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.timeoutMs, 5000);
});

// ── capability param threads through to spawn ──
test("execute threads capability through to spawn", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "describe image", capability: "vision" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.capability, "vision");
});

test("renderSubagentCall shows capability:<name> slot", () => {
  const out = renderSubagentCall({ capability: "vision", task: "x" }, T);
  assert.match(String(out), /capability:vision/);
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

test("execute fans the runtime abort signal into a per-child externalSignal (not the same object)", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const controller = new AbortController();
  await tool.execute("id", { task: "t" }, controller.signal, undefined, NO_CTX);
  const childSignal = f.calls[0]?.externalSignal;
  assert.ok(childSignal, "spawn receives an externalSignal");
  assert.notEqual(childSignal, controller.signal, "per-child controller, not the parent signal directly");
  // fan-in: aborting the parent signal aborts the child signal (whole-turn Esc still works)
  assert.equal(childSignal.aborted, false);
  controller.abort();
  assert.equal(childSignal.aborted, true, "parent signal fans into the per-child signal");
});

// ── per-child mid-flight abort (Frontier A) ──

/** Fake spawn that resolves ONLY when its externalSignal aborts (a child
 *  blocked on a real run, then aborted). Mirrors spawnSubagent's signal-abort
 *  return shape: {exitCode:124, timedOut:true, output:""}. */
function spawnOnAbort() {
  const calls: SpawnSubagentOptions[] = [];
  const spawn = (opts: SpawnSubagentOptions) =>
    new Promise<SpawnSubagentResult>((resolve) => {
      calls.push(opts);
      const sig = opts.externalSignal;
      if (!sig) return resolve({ output: "no-signal", exitCode: 0, stderr: "", timedOut: false });
      if (sig.aborted) return resolve({ output: "", exitCode: 124, stderr: "Subagent was aborted", timedOut: true });
      sig.addEventListener(
        "abort",
        () => resolve({ output: "", exitCode: 124, stderr: "Subagent was aborted", timedOut: true }),
        { once: true },
      );
    });
  return { calls, spawn };
}

test("user per-child abort (registry.abort) → status 'aborted' + 'Subagent aborted by user.' text; parent turn unaffected", async () => {
  const reg = new SubagentInFlightRegistry();
  const f = spawnOnAbort();
  // #02 default-on: captureCommitBaseline now runs even with an UNSET scope, so
  // hand in a fast fake gitOps (no real subprocess) — the single
  // `await Promise.resolve()` below must still reach the registered window.
  const tool = createSubagentTool({
    spawn: f.spawn,
    inFlight: reg,
    gitOps: fakeGitOps({ baseHead: "b1" }).ops,
  });
  const parent = new AbortController(); // NOT aborted — represents the live turn
  const p = tool.execute("id-u", { task: "research" }, parent.signal, undefined, NO_CTX);
  // #02 default-on: captureCommitBaseline now ALWAYS awaits gitOps.headCommit,
  // so the registered window is one microtask deeper than before the change.
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(typeof reg.get("id-u")?.abort === "function", "abort lever wired on the in-flight entry");
  reg.abort("id-u"); // user aborts this one child
  const res = await p;
  assert.equal(res.details.status, "aborted");
  assert.equal((res.content[0] as { text: string }).text, "Subagent aborted by user.");
  assert.equal(parent.signal.aborted, false, "the parent turn is NOT aborted (per-child isolation)");
});

test("whole-turn abort (parent signal) → status 'timedout', NOT 'aborted' (unchanged)", async () => {
  const reg = new SubagentInFlightRegistry();
  const f = spawnOnAbort();
  const tool = createSubagentTool({ spawn: f.spawn, inFlight: reg });
  const parent = new AbortController();
  const p = tool.execute("id-w", { task: "t" }, parent.signal, undefined, NO_CTX);
  await Promise.resolve();
  parent.abort(); // whole-turn Esc
  const res = await p;
  assert.equal(res.details.status, "timedout", "whole-turn abort keeps the existing timedout status");
});

test("a timeout (no controller abort) → status 'timedout', NOT 'aborted'", async () => {
  const f = fakeSpawn(() => ({ output: "", exitCode: 124, stderr: "", timedOut: true }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id-t", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.status, "timedout");
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

// ── optimization #1: default to the parent's gated active tool set ──
// (see .planning/2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task/ ticket 01)
// A spawned subagent must NOT re-inherit the full ~55-tool definition universe;
// when the caller omits `tools` (and no agentType binds one), it defaults to the
// parent's CURRENT active set (getActiveTools) so the child re-pays only the
// ~10k gated schema baseline, not ~18k. Explicit `tools` always overrides.

test("no-tools spawn defaults to the parent's gated active set (getActiveTools), not the full universe", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({
    spawn: f.spawn,
    getActiveTools: () => ["read", "grep", "find", "ls", "subagent"],
  });
  await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(
    f.calls[0]?.tools,
    ["read", "grep", "find", "ls", "subagent"],
    "a no-tools spawn narrows to the parent's gated active set, not the full universe",
  );
});

test("explicit `tools` override wins over the active-set default", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({
    spawn: f.spawn,
    getActiveTools: () => ["read", "grep", "find", "ls", "subagent"],
  });
  await tool.execute("id", { task: "t", tools: ["read", "grep"] }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(f.calls[0]?.tools, ["read", "grep"], "explicit tools still narrow to EXACTLY the requested set");
});

test("agentType `tools` binding wins over the active-set default", async () => {
  const registry = mkRegistry([{ name: "reader", tools: ["read", "grep"], prompt: "Read only.", source: "project" }]);
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({
    spawn: f.spawn,
    agentRegistry: registry,
    getActiveTools: () => ["read", "grep", "find", "ls", "subagent"],
  });
  await tool.execute("id", { task: "t", agentType: "reader" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(f.calls[0]?.tools, ["read", "grep"], "agentType binding narrows; active set is only the fallback");
});

test("no active set + no tools leaves tools undefined (best-effort when getActiveTools is unset)", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tools, undefined, "no default + no tools → undefined (caller/runner decides)");
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

// ── workIntentPreview (ticket 02 — surfaces work intent, strips cwd boilerplate) ──
test("workIntentPreview strips a leading 'Working dir: /path' line", () => {
  const task = "Working dir: /Users/huangziyu/proj/video_generation__subagent\nDo the thing now";
  const out = workIntentPreview(task, 60);
  assert.equal(out, "Do the thing now");
});

test("workIntentPreview strips a leading 'Cwd: /path' line", () => {
  const task = "Cwd: /somewhere/else\nFix the login bug";
  const out = workIntentPreview(task, 60);
  assert.equal(out, "Fix the login bug");
});

test("workIntentPreview strips a leading 'Repo: /org/repo' line", () => {
  const task = "Repo: /Users/me/my-project\nAdd unit tests for auth";
  const out = workIntentPreview(task, 60);
  assert.equal(out, "Add unit tests for auth");
});

test("workIntentPreview falls back to the first line when there is no preamble", () => {
  const task = "Investigate the crash in renderSubagentCall";
  const out = workIntentPreview(task);
  assert.equal(out, task);
});

test("workIntentPreview truncates the intent line to n chars", () => {
  const task =
    "Working dir: /x\nThis is a very long intent line that needs to be truncated to fit within the preview width limit";
  const out = workIntentPreview(task, 40);
  assert.equal(out.length, 40);
  assert.ok(out.endsWith("…"));
});

test("workIntentPreview skips blank lines after the preamble", () => {
  const task = "Working dir: /x\n\n\nReal work starts here";
  const out = workIntentPreview(task, 60);
  assert.equal(out, "Real work starts here");
});

test("workIntentPreview handles task with only a preamble line (fallback)", () => {
  const task = "Working dir: /Users/x/proj";
  const out = workIntentPreview(task, 60);
  assert.equal(out, "Working dir: /Users/x/proj");
});

// ── renderSubagentCall uses workIntentPreview (ticket 02) ──
test("renderSubagentCall header uses workIntentPreview — strips Working dir preamble", () => {
  const out = renderSubagentCall(
    { agent: "implementer", task: "Working dir: /x\nFix the race condition in subagent-tool" },
    T,
  );
  assert.ok(String(out).includes("Fix the race condition in subagent-tool"));
  assert.ok(!String(out).includes("Working dir"));
});

// ── formatSubagentProgress (onHistory → progress-line rendering) ──
test("formatSubagentProgress on empty history shows the '…' placeholder", () => {
  const out = formatSubagentProgress([], 0);
  assert.match(out, /…/);
});

test("formatSubagentProgress toolCall entry includes the verb-led phrase", () => {
  const history: AgentHistoryEntry[] = [
    { role: "assistant", kind: "toolCall", toolName: "grep", text: '{"pattern":"foo"}' },
  ];
  const out = formatSubagentProgress(history, 1000);
  assert.match(out, /Searching for "foo"/);
});

test("formatSubagentProgress toolResult entry is verb-led past (no '→ done')", () => {
  const history: AgentHistoryEntry[] = [{ role: "tool", kind: "toolResult", toolName: "read", text: "contents" }];
  const out = formatSubagentProgress(history, 1000);
  assert.match(out, /↳ Read/);
});

test("formatSubagentProgress text entry includes the (truncated) first line", () => {
  const history: AgentHistoryEntry[] = [
    { role: "assistant", kind: "text", text: "Investigating the failure\nmore detail" },
  ];
  const out = formatSubagentProgress(history, 1000);
  assert.match(out, /Investigating the failure/);
  assert.ok(!out.includes("more detail"), "only the first line is shown");
});

test("formatSubagentProgress error entry is marked distinctly as `Failed to …`", () => {
  const history: AgentHistoryEntry[] = [
    { role: "tool", kind: "error", toolName: "bash", text: "command not found: foo", isError: true },
  ];
  const out = formatSubagentProgress(history, 1000);
  assert.match(out, /Failed to run/, "error entries carry the Failed-to marker");
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
  // ticket 04 finding 5: model segment is shortened via shortModel (x/flash → flash)
  assert.ok(withRole.includes("flash"));
  assert.ok(!withRole.includes("x/flash"), "provider prefix dropped on the call line");
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
  // ticket 04 finding 5: resolved segment is shortened (google/gemma-4-12b-qat → gemma-4-12b-qat)
  assert.match(out, /tier:medium ▸ gemma-4-12b-qat ▸/);
});

test("renderSubagentCall omits resolved model before resolution (undefined)", () => {
  const out = renderSubagentCall({ agent: "auditor", tier: "medium", task: "x" }, T);
  assert.match(out, /tier:medium/);
  assert.doesNotMatch(out, /google/);
});

test("renderSubagentCall omits resolved model when it equals the explicit model slot (no dup)", () => {
  const out = renderSubagentCall({ agent: "scout", model: "x/flash", task: "x", resolvedModel: "x/flash" }, T);
  // Both shorten to "flash"; since they match, the resolved segment is omitted.
  assert.equal((out.match(/flash/g) || []).length, 1);
});

test("renderSubagentCall shows both explicit model and a different resolved model", () => {
  const out = renderSubagentCall(
    { agent: "scout", model: "x/flash", task: "x", resolvedModel: "google/gemma-4-12b-qat" },
    T,
  );
  // Both shortened on the call line (ticket 04 finding 5).
  assert.match(out, /flash/);
  assert.match(out, /gemma-4-12b-qat/);
  assert.ok(!out.includes("x/flash"), "provider prefix dropped on the explicit model slot");
  assert.ok(!out.includes("google/gemma-4-12b-qat"), "provider prefix dropped on the resolved segment");
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

// --- ticket 04 finding 3: settled result meta persists the fallback indicator ---
// The live call line showed `▸ opus ▸ → glm-5.2` mid-run, but on settle the meta
// collapsed to just the actual model and the fallback became invisible. Persist
// a `requested → actual` segment (shortened) on the settled meta so a surprising
// fallback survives settle.
test("renderSubagentResult settled meta shows `requested → actual` (shortened) when d.fellBack", () => {
  const out = renderSubagentResult(
    {
      content: [{ type: "text", text: "done" }],
      details: {
        exitCode: 0,
        timedOut: false,
        taskPreview: "p",
        elapsedMs: 1000,
        status: "done",
        model: "zai/glm-5.2",
        requestedModel: "anthropic/claude-opus-4-1",
        fellBack: true,
      },
    },
    { expanded: false },
    T,
  );
  assert.match(out, /claude-opus-4-1 → glm-5\.2/, "the fallback indicator persists after settle");
  assert.ok(!out.includes("anthropic/claude-opus-4-1"), "requested id shortened on the meta (finding 5)");
  assert.ok(!out.includes("zai/glm-5.2"), "actual id shortened on the meta (finding 5)");
});

test("renderSubagentResult settled meta shows only the actual model (shortened) when NOT fellBack", () => {
  const out = renderSubagentResult(
    {
      content: [{ type: "text", text: "done" }],
      details: {
        exitCode: 0,
        timedOut: false,
        taskPreview: "p",
        elapsedMs: 1000,
        status: "done",
        model: "zai/glm-5.2",
      },
    },
    { expanded: false },
    T,
  );
  assert.ok(out.includes("glm-5.2"), "the actual model is shown");
  assert.ok(!out.includes("zai/glm-5.2"), "actual id shortened on the meta (finding 5)");
  assert.doesNotMatch(out, /→ glm/, "no fallback indicator when there was no fallback");
});

test("renderSubagentResult renders an 'aborted' badge (distinct from failed/timedout)", () => {
  const out = renderSubagentResult(
    {
      content: [{ type: "text", text: "Subagent aborted by user." }],
      details: { exitCode: 124, timedOut: false, taskPreview: "p", elapsedMs: 800, status: "aborted" },
    },
    { expanded: false },
    T,
  );
  assert.match(out, /aborted/);
  assert.ok(!out.includes("failed") && !out.includes("timedout"), "not mislabeled as failed/timedout");
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
  assert.match(out, /→ Using read/);
  assert.match(out, /✓ Used read/);
  assert.match(out, /→ Using grep/);
});

test("formatSubagentLive surfaces the verb-led target on each trace line (debug visibility)", () => {
  // compactAgentHistory captures tool-call args (as compact JSON) into `text`;
  // the trace line surfaces the parsed target as a verb-led phrase. A toolResult
  // recovers the target from its matched preceding call.
  const history: AgentHistoryEntry[] = [
    { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/foo.ts"}' },
    { role: "tool", kind: "toolResult", toolName: "read", text: "export const x = 1;" },
  ];
  const out = formatSubagentLive(history, 1000);
  assert.match(out, /→ Reading src\/foo\.ts/, "tool-call target is surfaced as a verb-led phrase");
  assert.match(out, /✓ Read src\/foo\.ts/, "tool-result recovers the matched call's target");
});

test("formatSubagentLive renders a bare-args call as `→ Using <tool>` (no noise)", () => {
  // An empty-args tool call renders as a clean verb-only phrase — the `{}` adds
  // no information and would clutter the trace.
  const history: AgentHistoryEntry[] = [{ role: "assistant", kind: "toolCall", toolName: "ls", text: "{}" }];
  const out = formatSubagentLive(history, 0);
  assert.match(out, /→ Using ls$/m, "bare {} args collapse to a verb-only phrase");
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

test("formatSubagentLive: BATCHED calls+results label each result with its OWN file (inline trace fidelity)", () => {
  // The inline/foreground trace (the surface where the three identical
  // `✓ Read map.md` lines were observed). One turn emits N distinct reads
  // (toolCallIds tc1/tc2/tc3), then N matching results. Post-fix each result
  // trace line carries its OWN target — not the last call's.
  const out = formatSubagentLive(
    [
      { role: "assistant", kind: "toolCall", toolName: "read", toolCallId: "tc1", text: '{"path":"PRD.md"}' },
      { role: "assistant", kind: "toolCall", toolName: "read", toolCallId: "tc2", text: '{"path":"chromadb.md"}' },
      { role: "assistant", kind: "toolCall", toolName: "read", toolCallId: "tc3", text: '{"path":"map.md"}' },
      { role: "tool", kind: "toolResult", toolName: "read", toolCallId: "tc1", text: "PRD body" },
      { role: "tool", kind: "toolResult", toolName: "read", toolCallId: "tc2", text: "chromadb body" },
      { role: "tool", kind: "toolResult", toolName: "read", toolCallId: "tc3", text: "map body" },
    ],
    2000,
  );
  // Each result trace line resolves its OWN file (was: three `✓ Read map.md`).
  assert.match(out, /✓ Read PRD\.md/, "first result labels its OWN file (PRD)");
  assert.match(out, /✓ Read chromadb\.md/, "second result labels its OWN file (chromadb)");
  assert.match(out, /✓ Read map\.md/, "third result labels its OWN file (map)");
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
  assert.match(expanded, /→ Using read/);
  assert.match(expanded, /✓ Used read/);
  assert.ok(!collapsed.includes("✓ Used read"), "collapsed hides the trace (the ✓ result line is trace-only)");
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

// ── effort 2026-08-08 expanded-display-flicker (ticket 01): streaming-expanded viewport-safe tail ──
// The streaming-expanded (ctrl+o) live view is capped to a viewport-safe TAIL so
// the box stays small + height-stable (fits the terminal viewport → no per-frame
// fullRender → no whole-TUI flicker). Must mirror src `STREAMING_EXPANDED_TAIL`.
const STREAMING_TAIL = 16;

test("renderSubagentResult isPartial+expanded caps the trace to a viewport-safe tail (drops oldest)", () => {
  // 2 header lines + MANY trace lines (> 2 + STREAMING_TAIL) → box is capped.
  const header = "H-line-1\nH-line-2";
  const trace = Array.from({ length: 50 }, (_, i) => `trace-${i}`).join("\n");
  const text = `${header}\n${trace}`;
  const out = renderSubagentResult({ content: [{ type: "text", text }] }, { expanded: true, isPartial: true }, T);
  const lines = out.split("\n");
  assert.equal(lines.length, 2 + 1 + STREAMING_TAIL, "2 header + 1 ellipsis + last STREAMING_TAIL trace");
  assert.equal(lines[0], "H-line-1");
  assert.equal(lines[1], "H-line-2");
  assert.equal(lines[2], "…", "an ellipsis marks the dropped middle");
  // last STREAMING_TAIL trace lines retained, in order: trace-(50-16)..trace-49
  const expectedTail = Array.from({ length: STREAMING_TAIL }, (_, i) => `trace-${50 - STREAMING_TAIL + i}`);
  assert.deepEqual(lines.slice(3), expectedTail, "newest trace retained in order");
  assert.ok(!out.includes("trace-0") && !out.includes("trace-33"), "oldest trace dropped");
  assert.ok(out.includes("trace-49"), "newest trace kept");
});

test("renderSubagentResult isPartial+expanded shows ALL lines when few enough (no ellipsis)", () => {
  // 2 header lines + FEW trace lines (≤ 2 + STREAMING_TAIL) → small enough already.
  const header = "H-line-1\nH-line-2";
  const few = STREAMING_TAIL - 6; // 10 trace → 12 total ≤ 18 → all shown, no cap
  const trace = Array.from({ length: few }, (_, i) => `trace-${i}`).join("\n");
  const text = `${header}\n${trace}`;
  const out = renderSubagentResult({ content: [{ type: "text", text }] }, { expanded: true, isPartial: true }, T);
  assert.ok(!out.includes("…"), "no ellipsis when small enough");
  assert.equal(out.split("\n").length, 2 + few, "all lines shown");
  assert.ok(out.includes("trace-0") && out.includes(`trace-${few - 1}`), "every trace line retained");
});

test("renderSubagentResult isPartial+collapsed stays at 2 header lines regardless of trace size", () => {
  const header = "H-line-1\nH-line-2";
  const trace = Array.from({ length: 50 }, (_, i) => `trace-${i}`).join("\n");
  const text = `${header}\n${trace}`;
  const out = renderSubagentResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: true }, T);
  assert.equal(out.split("\n").length, 2, "collapsed = just the 2-line header");
  assert.ok(!out.includes("trace-0"), "collapsed hides the trace");
});

test("renderSubagentResult NON-partial+expanded renders the FULL report (streaming cap does not apply)", () => {
  // Settled report path must be UNCHANGED: no cap, even with a tall report.
  const details: SubagentToolDetails = {
    exitCode: 0,
    timedOut: false,
    taskPreview: "p",
    elapsedMs: 12_350,
    status: "done",
  };
  const full = Array.from({ length: 60 }, (_, i) => `Line ${i} of report`).join("\n");
  const out = renderSubagentResult({ content: [{ type: "text", text: full }], details }, { expanded: true }, T);
  assert.ok(!out.includes("…"), "no ellipsis on the settled report");
  assert.ok(
    out.includes("Line 0 of report") && out.includes("Line 59 of report"),
    "full report retained top-to-bottom",
  );
  assert.equal(out.split("\n").length, 1 + 60, "1 (badge+meta header) + all 60 report lines — uncapped");
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
  // #02 default-on: captureCommitBaseline now runs even with an UNSET scope, so
  // hand in a fast fake gitOps (no real subprocess) — the single
  // `await Promise.resolve()` below must still reach the registered window.
  // base===postHead keeps the post-run scope check empty (no commit → no ⚠).
  const tool = createSubagentTool({
    spawn: f.spawn,
    inFlight: reg,
    gitOps: fakeGitOps({ baseHead: "b1", postHead: "b1" }).ops,
  });
  const p = tool.execute(
    "id-7",
    { task: "do work", agent: "implementer", model: "x/flash" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  // #02 default-on: captureCommitBaseline now ALWAYS awaits gitOps.headCommit,
  // so the registered window is one microtask deeper than before the change.
  await Promise.resolve();
  await Promise.resolve();
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

test("commitScope unset → #02 default-on: git scope check STILL runs (capture + post-run), empty when no commit", async () => {
  const { calls, ops } = fakeGitOps({ baseHead: "b1", postHead: "b1" });
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn, gitOps: ops, cwd: "/repo" });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  // #02: unset scope is treated as [] (flag any commit). The check RUNS even
  // without an explicit commitScope — headCommit is called for baseline + post-run.
  assert.ok(res.details.scopeCheck, "scopeCheck present (default-on)");
  assert.deepEqual(res.details.scopeCheck?.outOfScope, [], "no commit → empty outOfScope");
  assert.equal(calls.headCwds.length, 2, "headCommit invoked twice (baseline + post-run check)");
  assert.ok(!(res.content[0] as { text: string }).text.includes("commit-scope violation"), "no warning when no commit");
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

// ── #01 tiered token-budget defaults (hard-abort; p90-calibrated) ──

test("#01 default budget: no tokenBudget + tier:small → spawn receives 500000", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id-bud", { task: "t", tier: "small" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tokenBudget, 500_000, "tier:small with no explicit budget → 500k default");
});

test("#01 default budget: explicit tokenBudget still wins", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id-bud2", { task: "t", tier: "small", tokenBudget: 999 }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tokenBudget, 999, "explicit tokenBudget overrides the tier default");
});

test("#01 default budget: no tier + no model → medium ceiling (1.2M)", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn }); // no getMainModel → mainModel undefined
  await tool.execute("id-bud3", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.tokenBudget, 1_200_000, "no tier, no model → safe medium fallback");
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

// ── live resolved-model wiring (Task 3: call line shows provider/model mid-run) ──

test("execute threads onModelResolved into registry.updateModel (live resolved model)", async () => {
  const reg = new SubagentInFlightRegistry();
  const updates: Array<[string, string]> = [];
  const orig = reg.updateModel.bind(reg);
  reg.updateModel = (id, model) => {
    updates.push([id, model]);
    orig(id, model);
  };
  const { spawn } = fakeSpawn(async (opts) => {
    opts.onModelResolved?.("google/gemma-4-12b-qat");
    return { exitCode: 0, output: "ok", stderr: "", timedOut: false, history: [] };
  });
  const tool = createSubagentTool({ spawn, inFlight: reg });
  await tool.execute("tc1", { task: "audit", tier: "medium" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(updates, [["tc1", "google/gemma-4-12b-qat"]]);
});

test("renderCall reads resolvedModel from the registry and binds invalidate", () => {
  const reg = new SubagentInFlightRegistry();
  const tool = createSubagentTool({ inFlight: reg });
  reg.start({ id: "tc9", model: "tier:medium", taskPreview: "x", startedAt: 0 });
  reg.updateModel("tc9", "google/gemma-4-12b-qat");
  let invalidated = 0;
  const text = new Text("", 0, 0);
  tool.renderCall?.({ agent: "auditor", tier: "medium", task: "x" }, T, {
    toolCallId: "tc9",
    lastComponent: text,
    invalidate: () => {
      invalidated++;
    },
  } as never);
  assert.match(text.render(200).join("\n"), /tier:medium ▸ gemma-4-12b-qat ▸/);
  // invalidate was bound — a later updateModel re-renders the call line
  reg.updateModel("tc9", "anthropic/claude-opus");
  assert.equal(invalidated, 1);
});

test("renderCall drops the resolved-model segment after the run ends (end() tears down the entry)", () => {
  const reg = new SubagentInFlightRegistry();
  const tool = createSubagentTool({ inFlight: reg });
  reg.start({ id: "tc-end", model: "tier:medium", taskPreview: "x", startedAt: 0 });
  reg.updateModel("tc-end", "google/gemma-4-12b-qat");
  const before = new Text("", 0, 0);
  tool.renderCall?.({ agent: "auditor", tier: "medium", task: "x" }, T, {
    toolCallId: "tc-end",
    lastComponent: before,
    invalidate: () => {},
  } as never);
  assert.match(before.render(200).join("\n"), /gemma-4-12b-qat/);
  // After completion the entry is gone — segment reverts; model lives on the result line.
  reg.end("tc-end");
  const after = new Text("", 0, 0);
  tool.renderCall?.({ agent: "auditor", tier: "medium", task: "x" }, T, {
    toolCallId: "tc-end",
    lastComponent: after,
    invalidate: () => {},
  } as never);
  const rendered = after.render(200).join("\n");
  assert.match(rendered, /tier:medium/);
  assert.doesNotMatch(rendered, /gemma-4-12b-qat/);
});

// ── formatHistoryLine (exported for the /subagents live-follow view) ──
test("formatHistoryLine renders a toolCall as `→ <verb-led phrase>`", () => {
  const out = formatHistoryLine({ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' });
  assert.match(out, /^→ Reading a\.ts/);
  assert.ok(out.includes("a.ts"), "surfaces the parsed target");
});

test("formatHistoryLine renders a toolResult as `✓ <past phrase>` (orphan → verb-only)", () => {
  // no ctx → no matchedCallArgs → verb-only past `Read`
  const out = formatHistoryLine({ role: "tool", kind: "toolResult", toolName: "read", text: "file contents here" });
  assert.match(out, /^✓ Read$/);
  // with matched args the target is recovered
  const paired = formatHistoryLine(
    { role: "tool", kind: "toolResult", toolName: "read", text: "file contents here" },
    { matchedCallArgs: { path: "a.ts" } },
  );
  assert.match(paired, /^✓ Read a\.ts/);
});

test("formatHistoryLine renders a whole-turn error as `⚠ …` (no double `✗ ⚠`)", () => {
  const out = formatHistoryLine({ role: "assistant", kind: "error", text: "boom", isError: true });
  assert.match(out, /^⚠ boom/);
});

test("formatHistoryLine renders a tool error with the `✗ Failed to …` marker", () => {
  const out = formatHistoryLine({ role: "tool", kind: "error", toolName: "bash", text: "exit 1", isError: true });
  assert.match(out, /^✗ Failed to run: exit 1/);
});

test("formatHistoryLine renders a tool error WITH its target when matchedCallArgs is supplied", () => {
  // Consistent with the toolResult branch: formatSubagentLive passes the
  // matching preceding toolCall's args via matchedCallArgsFor. A tool error
  // must recover the target it acted on (e.g. `✗ Failed to edit src/parser.ts: …`)
  // instead of the verb-only `✗ Failed to edit: …`.
  const out = formatHistoryLine(
    { role: "tool", kind: "error", toolName: "edit", text: "oldText not found", isError: true },
    { matchedCallArgs: { path: "src/parser.ts", edits: [{ oldText: "foo", newText: "bar" }] } },
  );
  assert.match(out, /^✗ Failed to edit src\/parser\.ts: oldText not found/);
  assert.ok(out.includes("src/parser.ts"), "surfaces the target the tool acted on");
});

// ── ticket 1: latestMessageLine (collapsed-box live line) ──

test("latestMessageLine returns null for empty history (caller omits the line)", () => {
  assert.equal(latestMessageLine([]), null);
});

test("latestMessageLine: assistant prose last → QUOTED first non-empty line (≤80)", () => {
  // The quotes are the visual signal distinguishing prose from a tool activity.
  const out = latestMessageLine([
    { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' },
    { role: "tool", kind: "toolResult", toolName: "read", text: "x" },
    { role: "assistant", kind: "text", text: "\n  \nNow checking the tests folder next." },
  ]);
  assert.equal(out, '↳ "Now checking the tests folder next."');
});

test("latestMessageLine: prose uses the first NON-empty line (skips blank leaders)", () => {
  const out = latestMessageLine([{ role: "assistant", kind: "text", text: "\n   \nFirst real line.\nsecond line." }]);
  assert.equal(out, '↳ "First real line."');
});

test("latestMessageLine: prose longer than 80 chars is ellipsized", () => {
  const long = "A".repeat(120);
  const out = latestMessageLine([{ role: "assistant", kind: "text", text: long }]);
  // 79 chars + ellipsis, wrapped in quotes.
  assert.match(out, /^↳ "A{79}…"$/);
});

test("latestMessageLine: a toolCall last → verb-led PRESENT activity (no quotes)", () => {
  const out = latestMessageLine([
    { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/foo.ts"}' },
  ]);
  assert.equal(out, "↳ Reading src/foo.ts");
});

test("latestMessageLine: a toolResult last → verb-led PAST activity (no quotes)", () => {
  const out = latestMessageLine([
    { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/foo.ts"}' },
    { role: "tool", kind: "toolResult", toolName: "read", text: "export const x = 1;" },
  ]);
  assert.equal(out, "↳ Read src/foo.ts");
});

test("latestMessageLine: an error last → the failure phrase (verb-led via describeLastActivity)", () => {
  const out = latestMessageLine([
    { role: "assistant", kind: "toolCall", toolName: "edit", text: '{"path":"src/p.ts"}' },
    { role: "tool", kind: "error", toolName: "edit", text: "oldText not found", isError: true },
  ]);
  // describeLastActivity's error branch delegates to formatToolAction(error) — a
  // verb-led `Failed to …` phrase. The target is NOT recovered here (the
  // expanded trace via formatHistoryLine does recover it — see formatSubagentTrace
  // tests); the collapsed line is a compact verb-led summary.
  assert.match(out, /^↳ Failed to edit: oldText not found/);
});

test("latestMessageLine: a whole-turn assistant error last → the `⚠ …` phrase", () => {
  const out = latestMessageLine([{ role: "assistant", kind: "error", text: "model overloaded", isError: true }]);
  assert.equal(out, "↳ ⚠ model overloaded");
});

test("latestMessageLine: assistant text that is blank/whitespace falls back to activity", () => {
  // An assistant text entry whose body is all whitespace is NOT prose — fall
  // through to the verb-led activity branch (describeLastActivity(text) → first
  // line ≤60, which is "" here; formatToolAction would say `…thinking`, but
  // describeLastActivity slices the raw first line). This guards the trim() gate.
  const out = latestMessageLine([
    { role: "assistant", kind: "toolCall", toolName: "grep", text: '{"pattern":"foo"}' },
    { role: "assistant", kind: "text", text: "   \n  " },
  ]);
  assert.ok(!out?.startsWith('↳ "'), "blank prose is not quoted");
});

// ── ticket 2: formatSubagentTrace (expanded-box grouped trace) ──

test("formatSubagentTrace: empty history → empty string", () => {
  assert.equal(formatSubagentTrace([], 1000), "");
});

test("formatSubagentTrace: a paired call+result collapses to ONE past-tense `✓` line (right target)", () => {
  const out = formatSubagentTrace(
    [
      { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/foo.ts"}' },
      { role: "tool", kind: "toolResult", toolName: "read", text: "export const x = 1;" },
    ],
    2100,
  );
  const lines = out.split("\n");
  assert.equal(lines.length, 2, "one past-tense line + one trailing progress line (no in-flight call)");
  assert.match(lines[0], /^✓ Read src\/foo\.ts$/, "call+result collapse to one past-tense line with the right target");
  assert.match(lines[1], /^2\.1s · 1 call$/, "trailing progress line when no call is in flight");
});

test("formatSubagentTrace: a trailing un-paired toolCall is in-flight (`→ …`) with progress on the same line", () => {
  const out = formatSubagentTrace(
    [{ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/baz.ts"}' }],
    2100,
  );
  const lines = out.split("\n");
  assert.equal(lines.length, 1, "a single in-flight line carries the progress (no trailing line)");
  assert.match(
    lines[0],
    /^→ Reading src\/baz\.ts … {3}2\.1s · 1 call$/,
    "in-flight marker + ellipsis + compact progress on one line",
  );
});

test("formatSubagentTrace: interspersed assistant prose renders inline between pairs", () => {
  const out = formatSubagentTrace(
    [
      { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' },
      { role: "tool", kind: "toolResult", toolName: "read", text: "x" },
      { role: "assistant", kind: "text", text: "Looks good, moving on." },
      { role: "assistant", kind: "toolCall", toolName: "grep", text: '{"pattern":"TODO"}' },
      { role: "tool", kind: "toolResult", toolName: "grep", text: "3 hits" },
    ],
    0,
  );
  const lines = out.split("\n");
  assert.match(lines[0], /^✓ Read a\.ts$/, "first pair collapsed");
  assert.equal(lines[1], "Looks good, moving on.", "prose rendered inline");
  assert.match(lines[2], /^✓ Searched for "TODO"$/, "second pair collapsed with its own target");
  assert.match(lines[3], /^0\.0s · 2 calls$/, "trailing progress (no in-flight call)");
});

test("formatSubagentTrace: an error entry renders inline via formatHistoryLine", () => {
  const out = formatSubagentTrace(
    [
      { role: "assistant", kind: "toolCall", toolName: "edit", text: '{"path":"src/p.ts"}' },
      { role: "tool", kind: "error", toolName: "edit", text: "oldText not found", isError: true },
    ],
    500,
  );
  const lines = out.split("\n");
  // The error is NOT a toolResult, so the call does NOT pair with it — the call
  // stays in-flight (carrying progress on its line) and the error renders as a
  // separate inline line via formatHistoryLine (`✗ Failed to …`).
  assert.match(lines[0], /^→ Editing src\/p\.ts … {3}0\.5s · 1 call$/, "the un-paired call is in-flight with progress");
  assert.match(lines[1], /^✗ Failed to edit src\/p\.ts: oldText not found/, "error inline via formatHistoryLine");
});

test("formatSubagentTrace: an ORPHAN result (no preceding call in the window) renders inline (verb-only past)", () => {
  const out = formatSubagentTrace([{ role: "tool", kind: "toolResult", toolName: "read", text: "orphan contents" }], 0);
  const lines = out.split("\n");
  assert.match(lines[0], /^✓ Read$/, "orphan result → verb-only past via formatHistoryLine");
  assert.match(lines[1], /^0\.0s · 0 calls$/, "trailing progress");
});

test("formatSubagentTrace: two CONSECUTIVE un-paired calls → both in-flight; the latest carries progress", () => {
  // A truncated mid-stream window can show two calls before any result. The
  // latest wins as "the" in-flight call (progress attaches there); the earlier
  // one stays a bare `→ …`.
  const out = formatSubagentTrace(
    [
      { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' },
      { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"b.ts"}' },
    ],
    3000,
  );
  const lines = out.split("\n");
  assert.match(lines[0], /^→ Reading a\.ts …$/, "earlier un-paired call is a bare in-flight line (no progress)");
  assert.match(lines[1], /^→ Reading b\.ts … {3}3\.0s · 2 calls$/, "latest un-paired call carries the progress");
});

test("formatSubagentTrace: minToolCalls floors the displayed count", () => {
  const out = formatSubagentTrace(
    [{ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' }],
    0,
    3,
  );
  assert.match(out, /3 calls/, "floor wins when history reports fewer calls");
});

test("formatSubagentTrace: BATCHED calls+results (one turn, N reads) each label their OWN file by id", () => {
  // The core trace-fidelity symptom: one assistant turn emits [read PRD, read
  // chromadb, read map] (distinct toolCallIds), then the three matching results
  // follow. Pre-fix every result collapsed to the LAST call -> three identical
  // `✓ Read map.md` lines (and two calls shown spuriously in-flight). Post-fix
  // each call pairs with its OWN result by toolCallId -> one correct line each.
  const out = formatSubagentTrace(
    [
      { role: "assistant", kind: "toolCall", toolName: "read", toolCallId: "tc1", text: '{"path":"PRD.md"}' },
      { role: "assistant", kind: "toolCall", toolName: "read", toolCallId: "tc2", text: '{"path":"chromadb.md"}' },
      { role: "assistant", kind: "toolCall", toolName: "read", toolCallId: "tc3", text: '{"path":"map.md"}' },
      { role: "tool", kind: "toolResult", toolName: "read", toolCallId: "tc1", text: "PRD body" },
      { role: "tool", kind: "toolResult", toolName: "read", toolCallId: "tc2", text: "chromadb body" },
      { role: "tool", kind: "toolResult", toolName: "read", toolCallId: "tc3", text: "map body" },
    ],
    2000,
  );
  const lines = out.split("\n");
  assert.match(lines[0], /^✓ Read PRD\.md$/, "first call pairs with its OWN result (PRD), not map");
  assert.match(lines[1], /^✓ Read chromadb\.md$/, "second call pairs with its OWN result (chromadb)");
  assert.match(lines[2], /^✓ Read map\.md$/, "third call pairs with its OWN result (map)");
  assert.match(lines[3], /^2\.0s · 3 calls$/, "trailing progress (no spurious in-flight calls)");
});

// ── ticket 03: model-fallback display + audit fields ──

test("renderSubagentCall with fellBack:true adds → fallback indicator", () => {
  const out = renderSubagentCall(
    {
      agent: "implementer",
      model: "anthropic/claude-opus-4-1",
      task: "do the thing",
      resolvedModel: "zai/glm-5.2",
      fellBack: true,
    },
    T,
  );
  // ticket 04 finding 5: the DISPLAY is shortened via shortModel. The audit
  // field (details.requestedModel) keeps the full spec; only the call line is
  // shortened so the collapsed line stays within terminal width.
  assert.ok(String(out).includes("claude-opus-4-1"), "requested model still visible (shortened)");
  assert.ok(!String(out).includes("anthropic/claude-opus-4-1"), "provider prefix dropped on the request slot");
  assert.ok(String(out).includes("glm-5.2"), "actual model shown (shortened)");
  // The fallback indicator (→) appears before the actual model
  assert.match(String(out), /→ glm-5\.2/);
});

test("renderSubagentCall with fellBack:false renders normally (no → prefix)", () => {
  const out = renderSubagentCall(
    {
      agent: "scout",
      tier: "small",
      task: "x",
      resolvedModel: "google/gemma-4-12b-qat",
      fellBack: false,
    },
    T,
  );
  // The resolved model segment is plain (no fallback indicator); shortened on display.
  assert.ok(String(out).includes("gemma-4-12b-qat"));
  assert.ok(!String(out).includes("google/gemma-4-12b-qat"), "provider prefix dropped on the resolved segment");
  assert.doesNotMatch(String(out), /→ gemma/);
});

test("renderSubagentCall with fellBack omitted (backward-compat) renders normally", () => {
  const out = renderSubagentCall(
    { agent: "auditor", tier: "medium", task: "x", resolvedModel: "google/gemma-4-12b-qat" },
    T,
  );
  assert.ok(String(out).includes("gemma-4-12b-qat"));
  assert.ok(!String(out).includes("google/gemma-4-12b-qat"), "provider prefix dropped on the resolved segment");
  assert.doesNotMatch(String(out), /→ gemma/);
});

test("execute with model fallback → details.requestedModel + fellBack set", async () => {
  const f = fakeSpawn((opts) => {
    // Simulate fallback: onModelFallback fires first, then onModelResolved with actual
    opts.onModelFallback?.("anthropic/claude-opus-4-1");
    opts.onModelResolved?.("zai/glm-5.2");
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  });
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t", model: "anthropic/claude-opus-4-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.model, "zai/glm-5.2", "model = ACTUAL (what ran)");
  assert.equal(res.details.requestedModel, "anthropic/claude-opus-4-1", "requestedModel = the spec that fell back");
  assert.equal(res.details.fellBack, true);
});

test("execute with normal resolution (no fallback) → no audit fields", async () => {
  const f = fakeSpawn((opts) => {
    // Normal resolution: onModelResolved fires without onModelFallback
    opts.onModelResolved?.("anthropic/claude-sonnet-4");
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  });
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t", model: "anthropic/claude-sonnet-4" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.model, "anthropic/claude-sonnet-4");
  assert.equal(res.details.requestedModel, undefined, "requestedModel absent when no fallback");
  assert.equal(res.details.fellBack, undefined, "fellBack absent when no fallback");
});

test("execute persists requestedModel + fellBack on fallback", async () => {
  const { saved, persistence } = fakePersistence();
  const f = fakeSpawn((opts) => {
    opts.onModelFallback?.("anthropic/claude-opus-4-1");
    opts.onModelResolved?.("zai/glm-5.2");
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  });
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id", { task: "t", model: "anthropic/claude-opus-4-1" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].model, "zai/glm-5.2", "persisted model = actual");
  assert.equal(saved[0].requestedModel, "anthropic/claude-opus-4-1", "persisted requestedModel = audit trace");
  assert.equal(saved[0].fellBack, true);
});

test("execute with normal resolution → persistence omits audit fields", async () => {
  const { saved, persistence } = fakePersistence();
  const f = fakeSpawn((opts) => {
    opts.onModelResolved?.("anthropic/claude-sonnet-4");
    return { output: "ok", exitCode: 0, stderr: "", timedOut: false };
  });
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id", { task: "t", model: "anthropic/claude-sonnet-4" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].model, "anthropic/claude-sonnet-4");
  assert.equal(saved[0].requestedModel, undefined, "requestedModel absent when no fallback");
  assert.equal(saved[0].fellBack, undefined, "fellBack absent when no fallback");
});

// ── #03 impossible-tool preflight (ABORT, pre-spawn) ──

test("#03 preflight: required tool absent from allowlist → failEarly, spawn NOT called", async () => {
  const f = fakeSpawn(() => ({ output: "should not reach", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute(
    "id-pf",
    { task: "write a memory entry", tools: ["read", "bash"], requiredTools: ["memory"] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls.length, 0, "spawn must NOT be called when a required tool is missing");
  assert.equal(res.details.status, "failed");
  assert.match(
    (res.content[0] as { text: string }).text,
    /preflight: task requires tools not in the child allowlist: memory/,
  );
});

test("#03 preflight: required tool satisfied → spawn IS called normally", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute(
    "id-ok",
    { task: "read a file", tools: ["read", "bash"], requiredTools: ["read"] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls.length, 1, "spawn IS called when the requirement is satisfied");
});

test("#03 preflight: required tool denied by excludeTools → failEarly", async () => {
  const f = fakeSpawn(() => ({ output: "x", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute(
    "id-ex",
    { task: "edit a file", tools: ["read", "edit"], excludeTools: ["edit"], requiredTools: ["edit"] },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  assert.equal(f.calls.length, 0);
  assert.match((res.content[0] as { text: string }).text, /edit/);
});

// ── #02 commitScope warn-default (default-on: unset scope ⇒ warn on any commit) ──

test("#02 default-on: UNSET commitScope + a commit → ⚠ block in output (never auto-reverts)", async () => {
  const f = fakeSpawn(() => ({ output: "done", exitCode: 0, stderr: "", timedOut: false }));
  // Fake git ops: HEAD was 'base' before, 'head' after → one touched path 'scratch.md'.
  // headCommit is called twice per checked run (call 1 pre-dispatch = base, call 2
  // post-run = head) — see fakeGitOps. The plan's literal `() => "head"` would make
  // base === head (no diff); the stateful helper matches the asserted violation.
  const { ops } = fakeGitOps({ baseHead: "base", postHead: "head", paths: ["scratch.md"] });
  const tool = createSubagentTool({ spawn: f.spawn, gitOps: ops });
  // NOTE: commitScope intentionally OMITTED — the default-on gate must still run.
  const res = await tool.execute("id-scope", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /⚠ commit-scope violation/, "unset scope that commits still warns");
  assert.match(text, /scratch\.md/);
  // Detection only — never auto-reverts (no destructive action available here anyway).
  assert.equal(res.details.scopeCheck?.outOfScope?.length, 1);
});

test("#02 default-on: UNSET commitScope + NO commit → no ⚠ (clean run)", async () => {
  const f = fakeSpawn(() => ({ output: "done", exitCode: 0, stderr: "", timedOut: false }));
  const gitOps = { headCommit: async () => "same", changedPaths: async () => [] } as never;
  const tool = createSubagentTool({ spawn: f.spawn, gitOps });
  const res = await tool.execute("id-clean", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  const text = (res.content[0] as { text: string }).text;
  assert.doesNotMatch(text, /commit-scope violation/);
});

// ── #04 retry-loop detector (circuit-break at N=2 consecutive identical) ──
// (named fakeHistoryPersistence to avoid colliding with the no-arg fakePersistence()
//  above; this one returns the persistence object directly, seeded with records.)

/** Minimal in-memory persistence for detector wiring tests. Returns the
 *  persistence object directly (list() yields the seeded records, newest-first). */
function fakeHistoryPersistence(records: SubagentRunRecord[]) {
  return {
    list: () => records,
    save: () => {},
    load: () => null,
    delete: () => false,
    getRunsDir: () => "/r",
  } as unknown as SubagentRunPersistence;
}

function mkRec(task: string, status: SubagentRunRecord["status"], stderr: string): SubagentRunRecord {
  return {
    id: "r",
    toolCallId: "c",
    task,
    model: "m",
    cwd: "/r",
    status,
    exitCode: 1,
    timedOut: false,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    elapsedMs: 1,
    output: "",
    stderr,
  } as SubagentRunRecord;
}

test("#04 circuit-break: 2 prior identical failures → failEarly, spawn NOT called", async () => {
  const f = fakeSpawn(() => ({ output: "should not reach", exitCode: 0, stderr: "", timedOut: false }));
  const task = "Fix the memory store bootstrap";
  const persistence = fakeHistoryPersistence([
    mkRec(task, "failed", "tool 'memory' not found"),
    mkRec(task, "failed", "tool 'memory' not found"),
  ]);
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  const res = await tool.execute("id-cb", { task }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls.length, 0, "spawn NOT called — circuit broken before spawn");
  assert.equal(res.details.status, "failed");
  assert.match((res.content[0] as { text: string }).text, /circuit-break.*already failed 2 consecutive times/i);
});

test("#04 circuit-break: 1 prior failure → NOT broken, spawn IS called (this is the 2nd attempt)", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const task = "Fix the memory store bootstrap";
  const persistence = fakeHistoryPersistence([mkRec(task, "failed", "tool 'memory' not found")]);
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id-cb2", { task }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls.length, 1, "1 prior failure is below the default threshold of 2 → dispatch runs");
});

test("#04 boundary: retryOnTransient's single in-dispatch retry is UNCHANGED (detector counts dispatch outcomes, not tryOnce calls)", async () => {
  // No prior records → no circuit-break. A transient failure still retries once
  // INSIDE spawn (tryOnce). The detector never interferes with that inner retry.
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const persistence = fakeHistoryPersistence([]); // clean history → never circuit-breaks
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id-bdy", { task: "unique task", retryOnTransient: true }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(
    f.calls.length,
    1,
    "spawn called once (the injected fake); retryOnTransient retry lives inside spawnSubagent, not the tool",
  );
});

test("#04 opt-out: retryCircuitBreak:0 disables the detector", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const task = "Fix the memory store bootstrap";
  const persistence = fakeHistoryPersistence([mkRec(task, "failed", "x"), mkRec(task, "failed", "x")]);
  const tool = createSubagentTool({ spawn: f.spawn, persistence });
  await tool.execute("id-optout", { task, retryCircuitBreak: 0 }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls.length, 1, "retryCircuitBreak:0 disables the preflight");
});
