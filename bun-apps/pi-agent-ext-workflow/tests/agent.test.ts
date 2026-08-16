import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentRunOptions, AgentUsage, ModelTierConfig, SddReport } from "@repo/pi-agent-core-runtime";
import {
  checkBudgetExhaustion,
  listAvailableModelSpecs,
  resolveAgentModelSpec,
  WorkflowAgent,
  WorkflowError,
  WorkflowErrorCode,
} from "@repo/pi-agent-core-runtime";
import { runWorkflow } from "../src/workflow.js";

// Private methods used for testing - cast to this type to access them without `any`
type WorkflowAgentPrivates = {
  buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string;
  lastAssistantText(messages: unknown[]): string;
  getTierConfig(): ModelTierConfig | null;
};

test("listAvailableModelSpecs returns an array (empty when no auth configured)", async () => {
  const result = await listAvailableModelSpecs();
  assert.ok(Array.isArray(result), "should always return an array");
  // On CI or fresh installs there may be no models configured
  // The important thing is it doesn't throw
});

test("listAvailableModelSpecs entries have provider/model format when non-empty", async () => {
  const result = await listAvailableModelSpecs();
  for (const spec of result) {
    assert.ok(spec.includes("/"), `model spec "${spec}" should use provider/id format`);
    const [provider, id] = spec.split("/");
    assert.ok(provider.length > 0, "provider should not be empty");
    assert.ok(id.length > 0, "model id should not be empty");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveAgentModelSpec — model precedence: explicit model > tier > main model
// ═══════════════════════════════════════════════════════════════════════════

const tierConfig: ModelTierConfig = {
  tiers: { small: "vendor/small", medium: "vendor/medium", big: "vendor/big" },
};
const loadCfg = () => tierConfig;
const noCfg = () => null;

test("resolveAgentModelSpec: explicit model wins over tier (the precedence bug fix)", () => {
  // Even with a tier set AND a config that resolves it, an explicit model wins.
  assert.equal(
    resolveAgentModelSpec({ model: "explicit/model", tier: "small" }, "main/model", loadCfg),
    "explicit/model",
  );
});

test("resolveAgentModelSpec: explicit model wins even when no config exists", () => {
  assert.equal(
    resolveAgentModelSpec({ model: "explicit/model", tier: "small" }, "main/model", noCfg),
    "explicit/model",
  );
});

test("resolveAgentModelSpec: tier resolves from config when no explicit model", () => {
  assert.equal(resolveAgentModelSpec({ tier: "big" }, "main/model", loadCfg), "vendor/big");
});

test("resolveAgentModelSpec: unconfigured tier falls back to the main model", () => {
  assert.equal(resolveAgentModelSpec({ tier: "small" }, "main/model", noCfg), "main/model");
  assert.equal(resolveAgentModelSpec({ tier: "unknown-tier" }, "main/model", loadCfg), "main/model");
});

// ─── RCA#6: an unknown/misspelled tier must WARN, not silently escalate cost ───

/** Capture console.warn calls during `fn`. */
function captureWarnings(fn: () => void): string[] {
  const calls: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => calls.push(msg);
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return calls;
}

test("RCA#6: a known tier resolves without warning", () => {
  const warnings = captureWarnings(() => {
    resolveAgentModelSpec({ tier: "big" }, "main/model", loadCfg);
  });
  assert.equal(warnings.length, 0, "a configured tier must not warn");
});

test("RCA#6: an unknown/misspelled tier warns AND falls back to the main model", () => {
  let result: string | undefined;
  const warnings = captureWarnings(() => {
    result = resolveAgentModelSpec({ tier: "lage" }, "main/expensive", loadCfg);
  });
  assert.equal(result, "main/expensive", "fallback value unchanged");
  assert.equal(warnings.length, 1, "exactly one warning for the misspelled tier");
  assert.match(warnings[0], /unknown tier "lage"/, "warn names the bad tier");
  assert.match(warnings[0], /main\/expensive/, "warn names the fallback model (the cost escalation)");
  assert.match(warnings[0], /small, medium, big/, "warn lists the configured tier names so typos are obvious");
});

test("RCA#6: a tier with NO config file warns that tiers are unconfigured", () => {
  let result: string | undefined;
  const warnings = captureWarnings(() => {
    result = resolveAgentModelSpec({ tier: "small" }, "main/model", noCfg);
  });
  assert.equal(result, "main/model", "fallback value unchanged");
  assert.equal(warnings.length, 1, "warns when no tier config exists at all");
  assert.match(warnings[0], /no model-tiers config found/, "warn explains the config is absent");
});

test("resolveAgentModelSpec: untagged agent defaults to the configured medium tier", () => {
  // The "set tier but nothing changed" fix: an agent with no model and no tier
  // falls back to the user's medium tier when a config exists.
  assert.equal(resolveAgentModelSpec({}, "main/model", loadCfg), "vendor/medium");
});

test("resolveAgentModelSpec: untagged agent with NO config falls through to session default", () => {
  assert.equal(resolveAgentModelSpec({}, "main/model", noCfg), undefined);
});

test("resolveAgentModelSpec: untagged agent with a config lacking a medium tier => session default", () => {
  const noMedium = () => ({ tiers: { small: "vendor/small" } });
  assert.equal(resolveAgentModelSpec({}, "main/model", noMedium), undefined);
});

test("resolveAgentModelSpec: tier with no main model and no config yields undefined", () => {
  assert.equal(resolveAgentModelSpec({ tier: "small" }, undefined, noCfg), undefined);
});

test("WorkflowAgent constructor accepts all option shapes without throwing", () => {
  const optionSets = [
    undefined,
    { cwd: "/tmp" },
    { cwd: "/tmp", instructions: "custom instruction" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test" },
    { cwd: "/tmp", mainModel: "openai/gpt-4.1" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test", mainModel: "openai/gpt-4.1" },
  ];
  for (const opts of optionSets) {
    const agent = opts ? new WorkflowAgent(opts) : new WorkflowAgent();
    assert.ok(agent instanceof WorkflowAgent, `agent should be constructed for options: ${JSON.stringify(opts)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// tier-config cache — a run with many default agents must not re-read disk
// ═══════════════════════════════════════════════════════════════════════════

test("WorkflowAgent caches the tier config: loadTierConfig runs at most once per instance", () => {
  let calls = 0;
  const cfg: ModelTierConfig = { tiers: { small: "v/small", medium: "v/medium", big: "v/big" } };
  const agent = new WorkflowAgent({
    cwd: "/tmp",
    mainModel: "main/model",
    loadTierConfig: () => {
      calls++;
      return cfg;
    },
  }) as WorkflowAgent & WorkflowAgentPrivates;

  // Multiple resolutions (as many default/untagged agents would trigger) read
  // the cache, not disk.
  assert.equal(agent.getTierConfig(), cfg);
  assert.equal(agent.getTierConfig(), cfg);
  assert.equal(agent.getTierConfig(), cfg);
  assert.equal(calls, 1, "loadTierConfig must run exactly once across repeated reads");
});

test("WorkflowAgent caches a null tier config (absent file) without re-reading", () => {
  let calls = 0;
  const agent = new WorkflowAgent({
    cwd: "/tmp",
    loadTierConfig: () => {
      calls++;
      return null;
    },
  }) as WorkflowAgent & WorkflowAgentPrivates;

  assert.equal(agent.getTierConfig(), null);
  assert.equal(agent.getTierConfig(), null);
  assert.equal(calls, 1, "a null (absent-file) result is cached, not re-probed");
});

test("WorkflowAgent defaults loadTierConfig to the real disk loader without throwing", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" }) as WorkflowAgent & WorkflowAgentPrivates;
  // No throw; returns the on-disk config or null when the file is absent.
  const cfg = agent.getTierConfig();
  assert.ok(cfg === null || (typeof cfg === "object" && typeof cfg.tiers === "object"));
});

// ═══════════════════════════════════════════════════════════════════════════
// buildPrompt — verifies that the agent's internal prompt assembly is correct
// ═══════════════════════════════════════════════════════════════════════════

test("buildPrompt includes base instructions, task label, and user prompt", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a helper." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "analyze this",
    { label: "analyzer" },
    false,
  );
  assert.ok(built.includes("You are a helper."), "should include base instructions");
  assert.ok(built.includes("Task label: analyzer"), "should include task label");
  assert.ok(built.includes("analyze this"), "should include user prompt");
});

test("buildPrompt includes per-call instructions when provided", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Base." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "do it",
    { label: "x", instructions: "Extra." },
    false,
  );
  assert.ok(built.includes("Base."), "base instructions");
  assert.ok(built.includes("Extra."), "per-call instructions");
  assert.ok(built.includes("do it"), "user prompt");
});

test("buildPrompt injects structured output contract when schema is used", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("return result", { label: "t" }, true);
  assert.ok(built.includes("structured_output"), "should mention structured_output");
  assert.ok(built.includes("Final output contract:"), "should include contract header");
  assert.ok(built.includes("Do not emit a prose final answer"), "should discourage prose");
  assert.ok(built.includes("call structured_output exactly once"), "should enforce single call");
});

test("buildPrompt works without base instructions", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", { label: "greeter" }, false);
  assert.ok(built.includes("Task label: greeter"), "should contain Task label: greeter");
  assert.ok(built.includes("hello"), "should contain hello");
});

test("buildPrompt works without label", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Help." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", {}, false);
  assert.ok(built.includes("Help."), "should contain Help.");
  assert.ok(built.includes("hello"), "should contain hello");
  assert.ok(!built.includes("Task label:"), "no label when omitted");
});

test("buildPrompt includes both instructions when both base and per-call are set", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a code reviewer." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "check this file",
    { label: "reviewer", instructions: "Focus on security." },
    true,
  );
  // Order: base instructions, per-call instructions, label, prompt, structured contract
  assert.ok(built.indexOf("You are a code reviewer.") < built.indexOf("Focus on security."), "base before per-call");
  assert.ok(built.indexOf("Focus on security.") < built.indexOf("Task label: reviewer"), "per-call before label");
  assert.ok(built.indexOf("Task label: reviewer") < built.indexOf("check this file"), "label before prompt");
  assert.ok(
    built.indexOf("check this file") < built.indexOf("Final output contract:"),
    "prompt before structured contract",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// lastAssistantText — verifies text extraction from session messages
// ═══════════════════════════════════════════════════════════════════════════

test("lastAssistantText extracts last assistant text content", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "hi there");
});

test("lastAssistantText joins multiple text parts", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "part1part2");
});

test("lastAssistantText skips non-text content parts", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1" },
        { type: "text", text: "result" },
      ],
    },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "result");
});

test("lastAssistantText returns empty string when no assistant text", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText([]);
  assert.equal(text, "");
});

test("lastAssistantText returns empty for non-assistant messages", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "");
});

test("lastAssistantText picks the last assistant message, not first", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "more" }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];
  const text: string = (agent as unknown as WorkflowAgentPrivates).lastAssistantText(messages);
  assert.equal(text, "final");
});

// ═══════════════════════════════════════════════════════════════════════════
// Full agent() pipeline inside runWorkflow — verifies the agent() function
// in workflow.ts correctly invokes the runner with all options.
// ═══════════════════════════════════════════════════════════════════════════

/** A smart mock agent runner that records every call and validates options shape. */
class CallRecordingAgent {
  calls: Array<{
    prompt: string;
    options: Record<string, unknown>;
  }> = [];

  result: unknown = "mock-result";

  async run(prompt: string, options: any) {
    this.calls.push({ prompt, options: { ...options } });
    // Fire callbacks with synthetic data to test the full pipeline
    options.onUsage?.({
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 30,
      cost: 0.001,
    } satisfies AgentUsage);
    options.onModelResolved?.("openai/gpt-4.1-mini");
    return this.result;
  }
}

test("agent() in workflow passes prompt and label to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze this', { label: 'analyzer' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].prompt, "analyze this");
});

test("agent() in workflow passes model spec to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { model?: string }).model, "fast-llm/model");
});

test("agent() in workflow fires onAgentStart and onAgentEnd callbacks", async () => {
  const rec = new CallRecordingAgent();
  const events: string[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => events.push(`start:${e.label}`),
      onAgentEnd: (e) => events.push(`end:${e.label}`),
    },
  );
  assert.deepEqual(events, ["start:greeter", "end:greeter"]);
});

test("agent() in workflow forwards compact subagent history snapshots", async () => {
  const historyRunner = {
    async run(_prompt: string, options: any) {
      options.onHistory?.([{ role: "assistant", kind: "text", text: "working" }]);
      return "done";
    },
  };
  const histories: Array<{ label: string; history: Array<{ text: string }> }> = [];

  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: historyRunner,
      persistLogs: false,
      onAgentHistory: (event) => histories.push(event),
    },
  );

  assert.equal(histories.length, 1);
  assert.equal(histories[0].label, "greeter");
  assert.equal(histories[0].history[0].text, "working");
});

test("agent() in workflow surfaces the parsed SDD report on onAgentEnd (parity with subagent tool)", async () => {
  const report: SddReport = {
    status: "DONE",
    commits: ["abc1234"],
    testSummary: "14/14 passing",
    concerns: "none",
  };
  const sddRunner = {
    async run(_prompt: string, options: any) {
      // The real WorkflowAgent.run fires this with parseSddReport(text); the
      // mock fires it directly to test the workflow.ts wiring.
      options.onSddReport?.(report);
      return "done with an SDD self-report block";
    },
  };
  const ends: Array<{ label: string; sddReport?: SddReport }> = [];

  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('implement', { label: 'impl' })
     return 1`,
    { agent: sddRunner, persistLogs: false, onAgentEnd: (e) => ends.push({ label: e.label, sddReport: e.sddReport }) },
  );

  assert.equal(ends.length, 1, "onAgentEnd fired once");
  assert.equal(ends[0].label, "impl");
  assert.deepEqual(ends[0].sddReport, report, "parsed SDD report surfaced on the end event");
});

test("agent() in workflow surfaces sddReport undefined when the output has no SDD block", async () => {
  const noReportRunner = {
    async run(_prompt: string, options: any) {
      // No SDD block in the output → runner fires onSddReport with undefined.
      options.onSddReport?.(undefined);
      return "plain prose, no self-report";
    },
  };
  const ends: Array<{ sddReport?: SddReport }> = [];

  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('work', { label: 'w' })
     return 1`,
    { agent: noReportRunner, persistLogs: false, onAgentEnd: (e) => ends.push({ sddReport: e.sddReport }) },
  );

  assert.equal(ends.length, 1);
  assert.equal(ends[0].sddReport, undefined, "no SDD block → undefined, never an error");
});

test("agent() in workflow fires onAgentStart with phase info", async () => {
  const rec = new CallRecordingAgent();
  const starts: Array<{ label: string; phase?: string }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't', phases: [{ title: 'Phase1' }] }
     phase('Phase1')
     await agent('work', { label: 'w' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => starts.push({ label: e.label, phase: e.phase }),
    },
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].phase, "Phase1");
});

test("agent() in workflow returns runner result", async () => {
  const rec = new CallRecordingAgent();
  rec.result = { findings: ["issue1"] };
  const result = await runWorkflow<{ findings: string[] }>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze', { label: 'a' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.deepEqual(result.result, { findings: ["issue1"] });
});

test("agent() in workflow returns null for recoverable errors", async () => {
  const failer = {
    async run() {
      throw new Error("recoverable agent error");
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('failing task', { label: 'f' })
     return r`,
    { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );
  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "recoverable agent error");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow treats empty text output as a recoverable failure", async () => {
  const rec = new CallRecordingAgent();
  rec.result = "   ";
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('empty task', { label: 'empty' })
     return r`,
    { agent: rec, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );

  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "Subagent produced no assistant output");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow reports non-recoverable errors before throwing", async () => {
  const failer = {
    async run() {
      throw new WorkflowError("schema failed", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;

  await assert.rejects(
    () =>
      runWorkflow<unknown>(
        `export const meta = { name: 'test', description: 't' }
         await agent('schema task', { label: 'schema' })
         return 1`,
        { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
      ),
    (err) => err instanceof WorkflowError && err.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
  );

  assert.equal(end?.result, null);
  assert.equal(end?.error, "schema failed");
  assert.equal(end?.errorCode, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
  assert.equal(end?.recoverable, false);
});

test("agent() in workflow fires onTokenUsage after run", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ input: number; output: number; total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ input: u.input, output: u.output, total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "should fire onTokenUsage once");
  assert.equal(usageEvents[0].total, 30, "should accumulate from agent usage");
});

test("agent() passes onModelResolved callback for display model updates", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't', model: 'some/model' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentEnd: (e) => {
        assert.equal(e.model, "openai/gpt-4.1-mini");
      },
    },
  );
  assert.ok(rec.calls.length > 0, "rec.calls should not be empty");
});

test("agent() accumulates usage across multiple agents", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('first', { label: 'a' })
     await agent('second', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "one final usage event");
  assert.equal(usageEvents[0].total, 60, "two agents × 30 tokens each");
});

test("agent() with timeout should handle gracefully (timeout returns null)", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 50));
      return "slow";
    },
  };
  let errorMessage = "";
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     let val = null
     try { val = await agent('slow', { label: 's', timeoutMs: 5 }) } catch (e) { val = 'error:' + (e && e.message || e) }
     return { val }`,
    {
      agent: slow,
      persistLogs: false,
      onAgentEnd: (event) => {
        if (event.error) errorMessage = event.error;
      },
    },
  );
  const r = result.result as { val: unknown };
  // agent() catches timeout internally (recoverable) and returns null
  assert.equal(r.val, null, "timeout agent should return null (recoverable)");
  assert.match(errorMessage, /timed out after 5ms/);
  assert.match(errorMessage, /raise or omit timeoutMs\/agentTimeoutMs/);
});

test("agent() default timeout is unbounded", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's' })
     return { val }`,
    { agent: slow, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() timeoutMs null overrides a run-level timeout", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's', timeoutMs: null })
     return { val }`,
    { agent: slow, agentTimeoutMs: 5, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() with parallel invokes all agents", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await parallel(['a','b','c'].map(p => () => agent(p, { label: p })))
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 3);
  const prompts = rec.calls.map((c) => c.prompt).sort();
  assert.deepEqual(prompts, ["a", "b", "c"]);
});

test("agent() with pipeline invokes agent per stage per item", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await pipeline(['x','y'],
       item => agent('stage1 ' + item, { label: 's1-' + item }),
       result => agent('stage2 ' + result, { label: 's2-' + result }),
     )
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 4); // 2 items × 2 stages
});

test("agent() monitors agent count and calls onAgentStart/End for each", async () => {
  const rec = new CallRecordingAgent();
  const counts: number[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('a', { label: 'a' })
     await agent('b', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: () => {},
      onAgentEnd: (e) => counts.push(e.tokens ?? 0),
    },
  );
  assert.equal(counts.length, 2);
  assert.ok(counts[0] > 0, "first agent tokens");
  assert.ok(counts[1] > 0, "second agent tokens");
});

// ── checkBudgetExhaustion (pure threshold logic for tokenBudget/spendBudget) ──

test("checkBudgetExhaustion: tokens exceeded → {kind:'tokens'}", () => {
  assert.deepEqual(checkBudgetExhaustion({ tokens: { total: 1234 }, cost: 0.01 }, { tokenBudget: 1000 }), {
    kind: "tokens",
    limit: 1000,
    actual: 1234,
  });
});

test("checkBudgetExhaustion: spend exceeded → {kind:'spend'}", () => {
  assert.deepEqual(checkBudgetExhaustion({ tokens: { total: 10 }, cost: 0.62 }, { spendBudget: 0.5 }), {
    kind: "spend",
    limit: 0.5,
    actual: 0.62,
  });
});

test("checkBudgetExhaustion: both exceeded → tokens wins (checked first)", () => {
  assert.equal(
    checkBudgetExhaustion({ tokens: { total: 2000 }, cost: 1.0 }, { tokenBudget: 1000, spendBudget: 0.5 })?.kind,
    "tokens",
  );
});

test("checkBudgetExhaustion: under limit → undefined", () => {
  assert.equal(
    checkBudgetExhaustion({ tokens: { total: 500 }, cost: 0.1 }, { tokenBudget: 1000, spendBudget: 0.5 }),
    undefined,
  );
});

test("checkBudgetExhaustion: no budget set → undefined", () => {
  assert.equal(checkBudgetExhaustion({ tokens: { total: 9999 }, cost: 99 }, {}), undefined);
});

test("checkBudgetExhaustion: exactly at limit is allowed (strict >)", () => {
  assert.equal(
    checkBudgetExhaustion({ tokens: { total: 1000 }, cost: 0.5 }, { tokenBudget: 1000, spendBudget: 0.5 }),
    undefined,
  );
});

test("checkBudgetExhaustion: only one budget set — checks just that one", () => {
  assert.equal(
    checkBudgetExhaustion({ tokens: { total: 9999 }, cost: 0.1 }, { spendBudget: 0.5 }),
    undefined,
    "tokenBudget unset → huge tokens ignored",
  );
  assert.equal(checkBudgetExhaustion({ tokens: { total: 10 }, cost: 2 }, { spendBudget: 0.5 })?.kind, "spend");
});
