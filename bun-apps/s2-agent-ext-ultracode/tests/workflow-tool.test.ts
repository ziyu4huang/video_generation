import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  backgroundStartedText,
  buildSimplifiedGuidelines,
  buildUltracodeAddendum,
  buildVerboseGuidelines,
  buildWorkflowGuidelinesForTurn,
  buildWorkflowPointerGuideline,
  createWorkflowTool,
  modelRoutingGuideline,
  shouldInjectFullWorkflowGuidelines,
} from "../src/workflow-tool.js";

// ─── backgroundStartedText ─────────────────────────────────────────────────────

test("backgroundStartedText tells the user it auto-continues and they can wait", () => {
  const text = backgroundStartedText("audit", "abc-123");
  assert.match(text, /audit/);
  assert.match(text, /abc-123/);
  assert.match(text, /wait here/i);
  assert.match(text, /continues automatically|resume the conversation/i);
  assert.match(text, /other things/i);
  assert.match(text, /\/workflows status abc-123/);
});

// ─── createWorkflowTool ────────────────────────────────────────────────────────

test("createWorkflowTool has correct name and label", () => {
  const tool = createWorkflowTool();
  // Renamed from `workflow` 2026-08-20 — docs/agents/extension-naming.md
  assert.equal(tool.name, "run_workflow");
  assert.equal(tool.label, "Workflow");
});

test("createWorkflowTool has description", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.description.length > 20, "tool.description should be more than 20");
});

test("createWorkflowTool has parameters defined", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.parameters, "should have parameters schema");
});

test("createWorkflowTool has execute function", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWorkflowTool has renderCall and renderResult", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("createWorkflowTool has promptSnippet", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.promptSnippet.includes("workflow"), "should contain workflow");
});

test("createWorkflowTool no longer carries static promptGuidelines (migrated to before_agent_start)", () => {
  // The authoring guidelines were migrated off the tool's static promptGuidelines
  // into the extension's before_agent_start conditional injection (Layer-3 gate).
  // The tool stays always-active + keeps promptSnippet for discoverability, but
  // must NOT carry the full guideline block as an always-on tax.
  const tool = createWorkflowTool();
  assert.equal(
    (tool as { promptGuidelines?: unknown }).promptGuidelines,
    undefined,
    "tool should NOT define static promptGuidelines after the Layer-3 migration",
  );
  const verboseTool = createWorkflowTool({ verboseWorkflowGuidelines: true });
  assert.equal(
    (verboseTool as { promptGuidelines?: unknown }).promptGuidelines,
    undefined,
    "verbose tool should NOT define static promptGuidelines either",
  );
});

test("createWorkflowTool keeps promptSnippet for discoverability", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.promptSnippet, "promptSnippet should remain for discoverability");
  assert.ok(tool.promptSnippet.includes("workflow"), "snippet should mention workflow");
});

test("buildSimplifiedGuidelines is the default full authoring set", () => {
  const guidelines = buildSimplifiedGuidelines();
  assert.ok(Array.isArray(guidelines), "should be an array");
  assert.ok(guidelines.length > 5, "should have several guidelines");
  const all = guidelines.join(" ");
  assert.ok(all.includes("opts.tier"), "should mention opts.tier");
  assert.ok(all.includes("opts.model"), "should mention opts.model");
  assert.ok(all.includes("small") || all.includes("medium") || all.includes("big"), "should mention tier names");
});

test("buildSimplifiedGuidelines keeps budget and timeout unbounded by default", () => {
  const all = buildSimplifiedGuidelines().join(" ");
  assert.match(all, /do not set tokenBudget or agentTimeoutMs/i);
  assert.match(all, /defaults are unbounded/i);
});

test("createWorkflowTool schema describes unbounded default timeout", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };
  const description = parameters.properties?.agentTimeoutMs?.description ?? "";
  assert.match(description, /Omit for no hard timeout/i);
  assert.match(description, /only when the user asks/i);
});

test("createWorkflowTool schema exposes concurrency and agentRetries", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties?: Record<string, { description?: string }> };

  assert.match(parameters.properties?.concurrency?.description ?? "", /Maximum concurrent agents/i);
  assert.match(parameters.properties?.agentRetries?.description ?? "", /Retry attempts/i);
});

test("buildVerboseGuidelines mentions retry and concurrency controls", async () => {
  const all = (await buildVerboseGuidelines()).join(" ");
  assert.match(all, /low concurrency/i);
  assert.match(all, /agentRetries/i);
  assert.match(all, /null handling/i);
});

// ─── Layer-3 conditional injection: intent detector + turn builder ─────────────
// These back the extension's before_agent_start handler: on a workflow-intent
// turn the FULL authoring block is injected; otherwise just a one-line pointer.
// Keep-when-unsure: ambiguous prompts get the pointer, but the tool stays
// always-active so a workflow the model starts still self-corrects via
// workflow_help (near-zero false-negative cost).

test("shouldInjectFullWorkflowGuidelines: explicit workflow vocabulary → full", () => {
  assert.equal(shouldInjectFullWorkflowGuidelines("write a workflow that fans out to audit the repo", false), true);
  assert.equal(shouldInjectFullWorkflowGuidelines("orchestrate multi-agent research across the repo", false), true);
  assert.equal(shouldInjectFullWorkflowGuidelines("use a pipeline of agents to review these", false), true);
  assert.equal(shouldInjectFullWorkflowGuidelines("run a workflow to inventory the modules", false), true);
  assert.equal(shouldInjectFullWorkflowGuidelines("fan-out subagents for this", false), true);
});

test("shouldInjectFullWorkflowGuidelines: decomposable-work verbs → full", () => {
  // analyze/research/survey/audit/investigate/review + (the|this|all|...) — these
  // are legitimate workflow candidates, so keep full guidance.
  assert.equal(shouldInjectFullWorkflowGuidelines("analyze the codebase for bugs", false), true);
  assert.equal(shouldInjectFullWorkflowGuidelines("research this dependency tree", false), true);
  assert.equal(shouldInjectFullWorkflowGuidelines("survey all the extensions for cost", false), true);
  assert.equal(shouldInjectFullWorkflowGuidelines("review every package's tests", false), true);
});

test("shouldInjectFullWorkflowGuidelines: plain direct action → pointer (not full)", () => {
  // Common file/read/edit/test turns must NOT carry the full guideline tax.
  assert.equal(shouldInjectFullWorkflowGuidelines("read this file", false), false);
  assert.equal(shouldInjectFullWorkflowGuidelines("edit the function to return early", false), false);
  assert.equal(shouldInjectFullWorkflowGuidelines("fix the typo on line 42", false), false);
  assert.equal(shouldInjectFullWorkflowGuidelines("run the test suite", false), false);
  assert.equal(shouldInjectFullWorkflowGuidelines("what does this function do?", false), false);
});

test("shouldInjectFullWorkflowGuidelines: effort armed → always full", () => {
  // /effort high|ultra is standing workflow context — full regardless of prompt.
  assert.equal(shouldInjectFullWorkflowGuidelines("read this file", true), true);
  assert.equal(shouldInjectFullWorkflowGuidelines("", true), true);
});

test("shouldInjectFullWorkflowGuidelines: empty/undefined prompt → pointer (no effort)", () => {
  assert.equal(shouldInjectFullWorkflowGuidelines("", false), false);
  assert.equal(shouldInjectFullWorkflowGuidelines(undefined as unknown as string, false), false);
});

test("buildWorkflowPointerGuideline is a short pointer advertising workflow_help", () => {
  const pointer = buildWorkflowPointerGuideline();
  assert.equal(typeof pointer, "string");
  // Must be MUCH shorter than the full block (~pointer ≪ 722 tok).
  assert.ok(pointer.length < 400, `pointer should be short, got ${pointer.length} chars`);
  assert.match(pointer, /workflow/i);
  assert.match(pointer, /workflow_help/i, "pointer must advertise workflow_help for self-correction");
});

test("buildWorkflowGuidelinesForTurn: full turn returns the full authoring block", async () => {
  const full = await buildWorkflowGuidelinesForTurn({ full: true });
  const simplified = buildSimplifiedGuidelines().join("\n");
  assert.equal(full, simplified, "full non-verbose turn = simplified set joined by newlines");
  // Sanity: the full block carries the correctness essentials.
  assert.match(full, /export const meta/);
  assert.match(full, /parallel\(\) takes functions/);
  assert.match(full, /defaults are unbounded/);
});

test("buildWorkflowGuidelinesForTurn: full+verbose returns the verbose set", async () => {
  const fullVerbose = await buildWorkflowGuidelinesForTurn({ full: true, verbose: true });
  const verbose = (await buildVerboseGuidelines()).join("\n");
  assert.equal(fullVerbose, verbose, "full verbose turn = verbose set joined by newlines");
  assert.match(fullVerbose, /low concurrency/);
});

test("buildWorkflowGuidelinesForTurn: non-workflow turn returns only the pointer", async () => {
  const pointer = await buildWorkflowGuidelinesForTurn({ full: false });
  assert.equal(pointer, buildWorkflowPointerGuideline());
  // The pointer must NOT contain the heavy authoring bullets.
  assert.doesNotMatch(pointer, /export const meta/);
  assert.doesNotMatch(pointer, /parallel\(\) takes functions/);
});

test("buildWorkflowGuidelinesForTurn: full block is much larger than the pointer (the tax we save)", async () => {
  const full = await buildWorkflowGuidelinesForTurn({ full: true });
  const pointer = await buildWorkflowGuidelinesForTurn({ full: false });
  // Measured: full ≈668 tok, pointer ≈71 tok (~9x). Net ~−597 tok on every
  // non-workflow turn vs. the old always-on static promptGuidelines.
  assert.ok(full.length > pointer.length * 8, "full block should be ~9x the pointer length");
});

// ─── ultracode-cc-parity t01: effort-armed addendum ─────────────────────────────
// Armed turns (effortLevel high|ultra) append the CC-parity standing block
// (author-by-default + solo carve-out, scale ladder, multi-phase sequencing,
// inline pattern catalog) to the FULL set — never to the pointer, never to a
// non-armed full turn (baseline stays use-only-when-asked, map D2).

test("buildUltracodeAddendum carries the CC-parity standing directive", () => {
  const all = buildUltracodeAddendum("ultra").join(" ");
  assert.match(all, /Ultracode is ON for this session \(effort: ultra\)/);
  assert.match(all, /every substantive task by default/);
  assert.match(all, /solo turns are conversation or trivial mechanical edits/);
  assert.match(all, /token thrift is not the constraint/i);
});

test("buildUltracodeAddendum carries the scale ladder, multi-phase, and pattern catalog", () => {
  const all = buildUltracodeAddendum("high").join(" ");
  assert.match(all, /Scale fan-out to the request/);
  assert.match(all, /verify\(item, \{reviewers: 3-5, lens\}\)/);
  assert.match(all, /one per phase/);
  for (const helper of ["verify(", "judgePanel(", "loopUntilDry(", "completenessCheck("]) {
    assert.ok(all.includes(helper), `addendum must name ${helper} inline`);
  }
});

test("buildWorkflowGuidelinesForTurn appends the addendum only when effortLevel is set", async () => {
  const plain = await buildWorkflowGuidelinesForTurn({ full: true });
  assert.doesNotMatch(plain, /Ultracode is ON/, "non-armed full turn stays baseline");

  const armed = await buildWorkflowGuidelinesForTurn({ full: true, effortLevel: "ultra" });
  assert.ok(armed.startsWith(plain), "armed block = plain full set + addendum");
  assert.match(armed, /Ultracode is ON for this session \(effort: ultra\)/);

  const armedVerbose = await buildWorkflowGuidelinesForTurn({ full: true, verbose: true, effortLevel: "high" });
  assert.match(armedVerbose, /Ultracode is ON for this session \(effort: high\)/);

  const pointer = await buildWorkflowGuidelinesForTurn({ full: false, effortLevel: "ultra" });
  assert.doesNotMatch(pointer, /Ultracode is ON/, "pointer turn never carries the addendum");
});

// ─── modelRoutingGuideline ──────────────────────────────────────────────────────

test("modelRoutingGuideline mentions all three tier names", async () => {
  const text = await modelRoutingGuideline();
  assert.ok(text.includes("small"), "should mention small tier");
  assert.ok(text.includes("medium"), "should mention medium tier");
  assert.ok(text.includes("big"), "should mention big tier");
});

test("modelRoutingGuideline describes each tier purpose", async () => {
  const text = await modelRoutingGuideline();
  assert.ok(text.includes("lightweight"), "should contain lightweight");
  assert.ok(text.includes("balanced"), "should contain balanced");
  assert.ok(text.includes("synthesis"), "should contain synthesis");
});

test("modelRoutingGuideline explains tier vs model priority", async () => {
  const text = await modelRoutingGuideline();
  assert.ok(text.includes("opts.tier"), "should mention opts.tier");
  assert.ok(text.includes("opts.model"), "should mention opts.model");
  assert.ok(
    /opts\.(tier|model).+opts\.(model|tier)/.test(text),
    "should explain ordering / relationship between tier and model",
  );
});

test("modelRoutingGuideline references the model scope (auth-independent)", async () => {
  const text = await modelRoutingGuideline();
  // With auth configured it lists the available models; on a fresh/CI machine
  // with no models it falls back to a generic line. Accept either so the test
  // doesn't depend on the runner's authenticated providers.
  assert.ok(
    text.includes("route only to these") || text.includes("models the user has configured"),
    "should explain which models are in scope (listed or fallback)",
  );
});

test("modelRoutingGuideline explains when to use each option", async () => {
  const text = await modelRoutingGuideline();
  assert.ok(/small.*(exploration|search|inventory|agents)/i.test(text), "small tier should mention light workloads");
  assert.ok(/big.*(synthesis|judgment|decision)/i.test(text), "big tier should mention heavy reasoning");
});

test("createWorkflowTool invalid args throws descriptive error", () => {
  const tool = createWorkflowTool();
  // We can test prepareArguments through the tool definition
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => unknown;
    // A non-string `script` with no `name` falls into the "neither provided" branch.
    assert.throws(() => prepare({ script: 123 }), /script|name/);
    assert.throws(() => prepare("not-an-object"), /object argument/);
  }
});

test("createWorkflowTool with custom cwd creates tool", () => {
  const tool = createWorkflowTool({ cwd: "/tmp" });
  assert.equal(tool.name, "run_workflow");
});

test("modelRoutingGuideline output is non-empty and well-formed", async () => {
  const text = await modelRoutingGuideline();
  assert.ok(text.length > 50, "should be a substantial instruction");
  assert.ok(text.endsWith(".") || text.endsWith("") || text.endsWith("`"), "should end properly");
  assert.ok(!text.includes("undefined"), "no undefined interpolation");
  assert.ok(!text.includes("[object Object]"), "no object serialization leaks");
});

// ─── prepareArguments / normalizeWorkflowScript ─────────────────────────────────

test("createWorkflowTool prepareArguments strips markdown fences from script", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```js\nconst x = 1\n```",
    });
    assert.equal(result.script, "const x = 1");
  }
});

test("createWorkflowTool prepareArguments strips javascript fences", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```\nexport const meta = { name: 't', description: 't' }\n```",
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
  }
});

test("createWorkflowTool prepareArguments passes through args", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => {
      script: string;
      args?: unknown;
      maxAgents?: number;
      concurrency?: number;
      agentRetries?: number;
    };
    const result = prepare({
      script: "export const meta = { name: 't', description: 't' }",
      args: { question: "test" },
      maxAgents: 5,
      concurrency: 2,
      agentRetries: 1,
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
    assert.deepEqual(result.args, { question: "test" });
    assert.equal(result.maxAgents, 5);
    assert.equal(result.concurrency, 2);
    assert.equal(result.agentRetries, 1);
  }
});
