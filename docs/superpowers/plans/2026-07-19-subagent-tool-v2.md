# Subagent Tool v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface capability the `subagent` tool's underlying `WorkflowAgent.run()` already implements — cost/token usage, `timeoutMs`/`retryOnTransient`, named `agentType` bindings (tools/model/prompt/worktree isolation), structured output (`schema`), and throttled live progress — through `bun-apps/pi-agent-ext-workflow`'s `subagent` tool, which today exposes none of it.

**Architecture:** Pure pass-through wiring, no new execution machinery. `src/spawn-subagent.ts` gains two new `SpawnSubagentOptions` fields (`onHistory`) and one new `SpawnSubagentResult` field (`usage`), both populated from callbacks `WorkflowAgent.run()` already accepts (`onUsage`, `onHistory` — the latter already throttled to ≥250ms internally). `src/subagent-tool.ts` gains four new tool parameters (`timeoutMs`, `retryOnTransient`, `agentType`, `schema`) and wires `_onUpdate` to the existing SDK partial-result contract (`renderResult(result, {isPartial: true})`). `agentType` resolves through the existing `agent-registry.ts`/`worktree.ts` helpers `workflow.ts`'s `agent()` already uses — no new registry or worktree code.

**Tech Stack:** TypeScript, Bun test runner, `@earendil-works/pi-coding-agent` (`defineTool`), `typebox`.

**Spec:** `docs/superpowers/specs/2026-07-19-subagent-tool-v2-design.md`

---

## Before you start

All commands below assume the repo root as cwd (per `CLAUDE.md`: never top-level `cd`). Run tests with:

```bash
( cd bun-apps/pi-agent-ext-workflow && bun test tests/<file>.test.ts )
```

Run the full package suite before the final commit of each phase:

```bash
( cd bun-apps/pi-agent-ext-workflow && bun test )
```

---

## Task 1: `spawn-subagent.ts` — capture and surface `usage`

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/spawn-subagent.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/spawn-subagent.test.ts`

`WorkflowAgent.run()` already accepts `onUsage?: (usage: AgentUsage) => void` (`src/agent.ts:268-274`), firing once per call — on both the success and error path — right before the session is disposed (`src/agent.ts:490-505`, inside the `finally` block, so it always fires before `run()`'s promise settles). `spawnSubagent()` doesn't pass this option today, so the usage it reads is thrown away.

- [ ] **Step 1: Write the failing tests**

Add to `bun-apps/pi-agent-ext-workflow/tests/spawn-subagent.test.ts`, inside the existing `describe("spawnSubagent", () => { ... })` block, right before the closing `});`:

```ts
  it("onUsage fires → result.usage carries the reported AgentUsage", async () => {
    const fixtureUsage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 0.002 };
    const runner = mkRunner(async (p) => {
      (p.opts.onUsage as ((u: typeof fixtureUsage) => void) | undefined)?.(fixtureUsage);
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", agent: runner });
    assert.deepEqual(out.usage, fixtureUsage);
  });

  it("usage is undefined when the runner never calls onUsage", async () => {
    const runner = mkRunner(async () => "ok");
    const out = await spawnSubagent({ task: "t", agent: runner });
    assert.equal(out.usage, undefined);
  });

  it("usage is preserved on a failure path too (onUsage fires before the throw propagates)", async () => {
    const fixtureUsage = { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, total: 20, cost: 0.0001 };
    const runner = mkRunner(async (p) => {
      (p.opts.onUsage as ((u: typeof fixtureUsage) => void) | undefined)?.(fixtureUsage);
      throw new Error("hard fail");
    });
    const out = await spawnSubagent({ task: "t", retryOnTransient: false, agent: runner });
    assert.deepEqual(out.usage, fixtureUsage);
    assert.equal(out.exitCode, 1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/spawn-subagent.test.ts )`
Expected: FAIL — `out.usage` is `undefined` in the first and third new tests (the property doesn't exist on the result yet, so `assert.deepEqual` fails).

- [ ] **Step 3: Implement `usage` capture**

In `bun-apps/pi-agent-ext-workflow/src/spawn-subagent.ts`:

1. Add an import for `AgentUsage` at the top (alongside the existing `WorkflowAgent` import):

```ts
import { WorkflowAgent, type AgentUsage } from "./agent.js";
```

2. Add `usage` to `SpawnSubagentResult`:

```ts
export interface SpawnSubagentResult {
  output: string;
  exitCode: number;
  stderr: string;
  timedOut: boolean;
  /** Real token/cost usage read from the child session, when the runner reports it. */
  usage?: AgentUsage;
}
```

3. In `spawnSubagent()`, update `tryOnce()` to capture usage and attach it to both branches of the try/catch:

```ts
  const tryOnce = async (): Promise<{ result: SpawnSubagentResult; transient: boolean }> => {
    const ac = new AbortController();
    if (opts.externalSignal) {
      if (opts.externalSignal.aborted) ac.abort();
      else opts.externalSignal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
    let usage: AgentUsage | undefined;
    try {
      // `prime` is intentionally NOT used here (③ owns the auto-primer).
      const out = await runner.run(opts.task, {
        label: "zk-spawn",
        schema: opts.schema,
        instructions: opts.instructions,
        model: opts.model,
        toolNames: opts.tools,
        disallowedToolNames: opts.excludeTools,
        cwd: opts.cwd,
        signal: ac.signal,
        onUsage: (u) => {
          usage = u;
        },
      } as Parameters<WorkflowAgent["run"]>[1]);
      // When `opts.schema` is set, `run()` returns a validated OBJECT (not a
      // string). `String(obj)` would yield "[object Object]" and silently
      // destroy the schema payload — JSON-serialize it instead so callers
      // that parse `output` keep working. Null/undefined → empty string.
      const output = typeof out === "string" ? out : out == null ? "" : JSON.stringify(out);
      return { result: { output, exitCode: 0, stderr: "", timedOut: false, usage }, transient: false };
    } catch (e) {
      const c = classifyError(e);
      return {
        result: { output: "", exitCode: c.timedOut ? 124 : 1, stderr: c.message, timedOut: c.timedOut, usage },
        transient: c.transient,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
```

(Only the `let usage` declaration, the `onUsage` callback in the `run()` call, and `usage` added to both `result` object literals are new — everything else in this block is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/spawn-subagent.test.ts )`
Expected: PASS — all tests including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/spawn-subagent.ts bun-apps/pi-agent-ext-workflow/tests/spawn-subagent.test.ts
git commit -m "feat(pi-agent-ext-workflow): spawnSubagent surfaces real usage/cost via onUsage"
```

---

## Task 2: `subagent-tool.ts` — surface `usage`, add `timeoutMs`/`retryOnTransient`

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`, after the existing `test("execute forwards the runtime abort signal to spawn as externalSignal", ...)` block:

```ts
test("execute forwards timeoutMs/retryOnTransient to spawn", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  await tool.execute("id", { task: "t", timeoutMs: 5000, retryOnTransient: false }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.timeoutMs, 5000);
  assert.equal(f.calls[0]?.retryOnTransient, false);
});

test("execute carries usage from the spawn result into details", async () => {
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.001 };
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false, usage }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.deepEqual(res.details.usage, usage);
});
```

Add to the "renderCall / renderResult" section, after `test("renderSubagentResult collapsed is short; expanded contains the full report", ...)`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `f.calls[0]?.timeoutMs`/`retryOnTransient` are `undefined` (not forwarded yet); `res.details.usage` is `undefined`; the render test fails because `renderSubagentResult` never emits a `$`/`tok` segment.

- [ ] **Step 3: Implement**

In `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`:

1. Add the `AgentUsage` type import (alongside the existing `spawn-subagent.js` import):

```ts
import type { AgentUsage } from "./agent.js";
```

2. Add `usage` to `SubagentToolDetails`:

```ts
export interface SubagentToolDetails {
  exitCode: number;
  timedOut: boolean;
  /** Role label (params.agent), if provided. */
  agent?: string;
  /** params.model, or "default". */
  model?: string;
  /** First ~80 chars of params.task, single-lined. */
  taskPreview: string;
  /** Wall-clock of the run, ms. */
  elapsedMs: number;
  status: "done" | "failed" | "timedout";
  /** Real token/cost usage from the child session, when reported. */
  usage?: AgentUsage;
}
```

3. Add `timeoutMs`/`retryOnTransient` to `subagentToolSchema`, right after `excludeTools`:

```ts
  excludeTools: Type.Optional(
    Type.Array(Type.String(), { description: "Tool names to deny after the allowlist (e.g. ['edit','write'])." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Abort the subagent if it runs longer than this many milliseconds. Omit for no timeout.",
    }),
  ),
  retryOnTransient: Type.Optional(
    Type.Boolean({
      description: "Retry once on a transient failure (timeout/network/rate-limit). Default true.",
    }),
  ),
});
```

(This replaces the schema's closing `});` — the new fields go before it, `excludeTools` stays where it is.)

4. In `execute()`, forward the two new params and attach `usage` to `details`:

```ts
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const t0 = Date.now();
      const result = await spawn({
        task: params.task,
        tools: params.tools,
        excludeTools: params.excludeTools,
        model: params.model,
        cwd: params.cwd ?? defaultCwd,
        instructions: params.agent ? `You are the ${params.agent} for this task.` : undefined,
        extensionTools: options.getExtensionTools?.(),
        externalSignal: signal,
        timeoutMs: params.timeoutMs,
        retryOnTransient: params.retryOnTransient,
      });
      return {
        content: [{ type: "text" as const, text: formatSubagentResult(result) }],
        details: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          agent: params.agent,
          model: params.model ?? "default",
          taskPreview: taskPreview(params.task),
          elapsedMs: Date.now() - t0,
          status: deriveSubagentStatus(result),
          usage: result.usage,
        },
      };
    },
```

5. Update `renderSubagentResult`'s meta line to append cost/tokens when usage is present and non-zero:

```ts
export function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: SubagentToolDetails },
  options: { expanded?: boolean },
  theme: Theme,
): string {
  const d = result.details;
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (!d) return text;
  const badge =
    d.status === "done"
      ? theme.fg("success", "✓ done")
      : d.status === "timedout"
        ? theme.fg("warning", "⏱ timedout")
        : theme.fg("error", "✗ failed");
  const usageStr =
    d.usage && d.usage.total > 0 ? ` · $${d.usage.cost.toFixed(3)} · ${d.usage.total} tok` : "";
  const meta = theme.fg("muted", `${d.model ?? "default"} · ${(d.elapsedMs / 1000).toFixed(1)}s${usageStr}`);
  if (!options.expanded) {
    const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
    return `${badge} ${meta} ${theme.fg("dim", truncateToWidth(firstLine, 60))}`;
  }
  return `${badge} ${meta}\n${theme.fg("toolOutput", text)}`;
}
```

(Only the `usageStr` line and its inclusion in `meta` are new.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: PASS — all tests including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts
git commit -m "feat(pi-agent-ext-workflow): subagent tool exposes usage/cost + timeoutMs/retryOnTransient"
```

---

## Task 3: `subagent-viewer.ts` — show usage in the `/subagents` output view

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts`, after the existing `test("reconstructSubagentRuns tolerates missing details ...", ...)` block:

```ts
test("reconstructSubagentRuns carries usage through from details", () => {
  const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 0.0023 };
  const branch = [
    toolResultEntry("subagent", "report", {
      exitCode: 0, timedOut: false, agent: "implementer", model: "x/flash",
      taskPreview: "task A", elapsedMs: 1000, status: "done", usage,
    } as Partial<SubagentToolDetails>),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.deepEqual(runs[0].usage, usage);
});

test("viewer output view shows cost/tokens when usage.total > 0", () => {
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A", {
      exitCode: 0, timedOut: false, agent: "implementer", model: "x/flash", taskPreview: "task A",
      elapsedMs: 1000, status: "done",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 0.0023 },
    } as Partial<SubagentToolDetails>),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("\r"); // enter → output view
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("$0.002"));
  assert.ok(out.includes("150 tok"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: FAIL — `runs[0].usage` is `undefined` (field doesn't exist on `SubagentRun` yet); the output view never contains `$0.002`/`150 tok`.

- [ ] **Step 3: Implement**

In `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts`:

1. Add the `AgentUsage` import (alongside the existing `SubagentToolDetails` import):

```ts
import type { AgentUsage } from "./agent.js";
import type { SubagentToolDetails } from "./subagent-tool.js";
```

2. Add `usage` to `SubagentRun`:

```ts
export interface SubagentRun {
  /** 1-based ordinal among subagent runs on this branch. */
  index: number;
  agent?: string;
  model: string;
  taskPreview: string;
  status: "done" | "failed" | "timedout";
  elapsedMs: number;
  /** Real token/cost usage, when reported. */
  usage?: AgentUsage;
  /** The full text the parent agent read (content[0].text). */
  output: string;
}
```

3. In `reconstructSubagentRuns`, carry `usage` through:

```ts
    runs.push({
      index: i,
      agent: d?.agent,
      model: d?.model ?? "default",
      taskPreview: d?.taskPreview ?? "",
      status,
      elapsedMs: d?.elapsedMs ?? 0,
      usage: d?.usage,
      output: msg.content?.find((c) => c.type === "text")?.text ?? "",
    });
```

4. In `renderOutput`, append cost/tokens to the header line when present:

```ts
  private renderOutput(width: number, th: Theme): string[] {
    const r = this.runs[this.selected];
    if (!r) return [""];
    const lines: string[] = [""];
    const usageStr = r.usage && r.usage.total > 0 ? ` • $${r.usage.cost.toFixed(3)} • ${r.usage.total} tok` : "";
    lines.push(
      truncateToWidth(
        `  ${th.fg("accent", `#${r.index}`)} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${r.model} • ${r.status} • ${(r.elapsedMs / 1000).toFixed(1)}s${usageStr}`,
        width,
      ),
    );
    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    for (const ln of r.output.split("\n")) {
      lines.push(truncateToWidth(`  ${th.fg("toolOutput", ln)}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "esc back to list")}`, width));
    lines.push("");
    return lines;
  }
```

(Only the `usageStr` line and its inclusion in the header `push` are new.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: PASS — all tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts
git commit -m "feat(pi-agent-ext-workflow): /subagents viewer shows cost/tokens per run"
```

---

## Task 4: Phase 1 docs

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/CONTEXT.md`
- Modify: `bun-apps/pi-agent-ext-workflow/PRD.md`

- [ ] **Step 1: Update CONTEXT.md**

Find the `subagent` tool's language entry in `bun-apps/pi-agent-ext-workflow/CONTEXT.md` (search for `subagent` tool). Add a short note after its existing description:

```markdown
As of the subagent-tool-v2 work, `subagent` also reports real usage
(`usage: {input, output, cacheRead, cacheWrite, total, cost}`) in its
`details` and the `/subagents` viewer, and accepts `timeoutMs` /
`retryOnTransient` to override the previously-hardcoded timeout-less,
always-retry-once defaults.
```

- [ ] **Step 2: Update PRD.md**

In `bun-apps/pi-agent-ext-workflow/PRD.md`, find the section describing the `subagent` tool (search for `subagent` near the tool-layer description around line 43). Add one sentence noting the new capability:

```markdown
`subagent` now reports real per-call token/cost usage and accepts
`timeoutMs`/`retryOnTransient` overrides (previously hardcoded).
```

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/CONTEXT.md bun-apps/pi-agent-ext-workflow/PRD.md
git commit -m "docs(pi-agent-ext-workflow): document subagent usage/timeoutMs/retryOnTransient"
```

---

## Task 5: `subagent-tool.ts` — `agentType` binding + worktree isolation

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`

`agent-registry.ts` already exports everything needed: `loadAgentRegistry(cwd)`, `resolveAgentType(name, registry)`, `listAgentTypes(registry)` (`src/agent-registry.ts:114-171`). `worktree.ts` already exports `createWorktree(baseCwd, name)` / `removeWorktree(wt)` (`src/worktree.ts:41-76`), which return a no-op `{isolated: false, cwd: baseCwd, reason}` on any failure — never throw. `workflow.ts`'s `agent()` (`src/workflow.ts:394-460`) is the reference precedence pattern this task mirrors: explicit call-site `model`/`tools`/`excludeTools` win over the `agentType` definition's fields.

- [ ] **Step 1: Write the failing tests**

Add to `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`, near the top, a small in-memory registry helper (after the `NO_CTX` constant):

```ts
import type { AgentDefinition, AgentRegistry } from "../src/agent-registry.js";

function mkRegistry(defs: AgentDefinition[]): AgentRegistry {
  const registry: AgentRegistry = new Map();
  for (const d of defs) registry.set(d.name, d);
  return registry;
}
```

Then add, after the `timeoutMs`/`retryOnTransient` test from Task 2:

```ts
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
      return { isolated: true, cwd: "/repo/.pi/worktrees/isolated-worker", repoRoot: "/repo", branch: "pi/wf/isolated-worker" };
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `createSubagentTool` doesn't accept `agentRegistry`/`createWorktree`/`removeWorktree` options yet (TypeScript error or the params are silently ignored and `agentType` isn't recognized), and `params.agentType` isn't read anywhere.

- [ ] **Step 3: Implement**

In `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`:

1. Add imports (alongside the existing ones):

```ts
import { listAgentTypes, loadAgentRegistry, resolveAgentType, type AgentRegistry } from "./agent-registry.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";
```

2. Add `agentType` to `subagentToolSchema`, right after the `agent` field:

```ts
export const subagentToolSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Informational role/label for the subagent (e.g. 'implementer', 'reviewer', 'researcher'). Forwarded as an instructions prefix; does not change tool selection.",
    }),
  ),
  agentType: Type.Optional(
    Type.String({
      description:
        "Named agent definition (.pi/agents/<name>.md or ~/.pi/agents/<name>.md) binding tools/model/prompt/worktree-isolation for this call. Explicit `model`/`tools`/`excludeTools` on this call override the binding's values.",
    }),
  ),
  task: Type.String({
```

3. Add `agentRegistry`, `createWorktree`, `removeWorktree` to `SubagentToolOptions` (injectable for tests, default to the real implementations):

```ts
export interface SubagentToolOptions {
  cwd?: string;
  /** Parent-session tools to bridge into the child. Updated by session_start. */
  getExtensionTools?: () => ToolDefinition[] | undefined;
  /** Injectable spawn for tests (defaults to the real spawnSubagent). */
  spawn?: (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
  /** Injectable agentType registry for tests (defaults to loadAgentRegistry(cwd) per call). */
  agentRegistry?: AgentRegistry;
  /** Injectable worktree creation for tests (defaults to the real createWorktree). */
  createWorktree?: typeof createWorktree;
  /** Injectable worktree teardown for tests (defaults to the real removeWorktree). */
  removeWorktree?: typeof removeWorktree;
}
```

4. Rewrite `execute()` to resolve `agentType` before spawning, apply its bindings with explicit-wins precedence, and wrap the run in worktree create/cleanup:

```ts
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      const t0 = Date.now();
      const runCwd = params.cwd ?? defaultCwd;
      const makeWorktree = options.createWorktree ?? createWorktree;
      const teardownWorktree = options.removeWorktree ?? removeWorktree;

      const failEarly = (text: string): { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails } => ({
        content: [{ type: "text" as const, text }],
        details: {
          exitCode: 1,
          timedOut: false,
          agent: params.agent,
          model: params.model ?? "default",
          taskPreview: taskPreview(params.task),
          elapsedMs: Date.now() - t0,
          status: "failed",
        },
      });

      let agentDef: import("./agent-registry.js").AgentDefinition | undefined;
      if (params.agentType) {
        const registry = options.agentRegistry ?? loadAgentRegistry(runCwd);
        agentDef = resolveAgentType(params.agentType, registry);
        if (!agentDef) {
          const known = listAgentTypes(registry).map((t) => t.name);
          return failEarly(
            `Unknown agentType "${params.agentType}".${
              known.length
                ? ` Available: ${known.join(", ")}.`
                : " No agentType definitions found (.pi/agents/*.md or ~/.pi/agents/*.md)."
            }`,
          );
        }
      }

      let worktree: Worktree | undefined;
      let spawnCwd = runCwd;
      if (agentDef?.isolation === "worktree") {
        worktree = await makeWorktree(runCwd, `subagent-${toolCallId}`);
        if (worktree.isolated) spawnCwd = worktree.cwd;
      }

      try {
        const instructions =
          [params.agent ? `You are the ${params.agent} for this task.` : undefined, agentDef?.prompt]
            .filter((s): s is string => Boolean(s))
            .join("\n\n") || undefined;

        const result = await spawn({
          task: params.task,
          tools: params.tools ?? agentDef?.tools,
          excludeTools: params.excludeTools ?? agentDef?.disallowedTools,
          model: params.model ?? agentDef?.model,
          cwd: spawnCwd,
          instructions,
          extensionTools: options.getExtensionTools?.(),
          externalSignal: signal,
          timeoutMs: params.timeoutMs,
          retryOnTransient: params.retryOnTransient,
        });
        return {
          content: [{ type: "text" as const, text: formatSubagentResult(result) }],
          details: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            agent: params.agent,
            model: params.model ?? agentDef?.model ?? "default",
            taskPreview: taskPreview(params.task),
            elapsedMs: Date.now() - t0,
            status: deriveSubagentStatus(result),
            usage: result.usage,
          },
        };
      } finally {
        if (worktree) await teardownWorktree(worktree);
      }
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: PASS — all tests including the four new ones. Also re-run the full package suite to catch any regression in the Task 1–2 tests from the `execute()` rewrite:

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts
git commit -m "feat(pi-agent-ext-workflow): subagent tool supports agentType binding + worktree isolation"
```

---

## Task 6: `subagent-tool.ts` — `schema` (structured output)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`

`spawnSubagent()` already accepts `schema?: TSchema` and passes it straight to `WorkflowAgent.run()`, which already builds a `structured_output` terminating tool from it (`src/structured-output.ts`, wired in `src/agent.ts:397-399`). This task only adds the tool-facing parameter and a minimal pre-flight shape check.

- [ ] **Step 1: Write the failing tests**

Add to `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`, after the `agentType` tests from Task 5:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `f.calls[0]?.schema` is `undefined` (not forwarded); the malformed-schema calls return the normal "ok" success path instead of an "Invalid schema" error, and `spawn` is called (`f.calls.length` is 2, not 0).

- [ ] **Step 3: Implement**

In `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`:

1. Add the `TSchema` type import (extend the existing `typebox` import):

```ts
import { Type, type TSchema } from "typebox";
```

2. Add `schema` to `subagentToolSchema`, right after `excludeTools`/`timeoutMs`/`retryOnTransient`:

```ts
  retryOnTransient: Type.Optional(
    Type.Boolean({
      description: "Retry once on a transient failure (timeout/network/rate-limit). Default true.",
    }),
  ),
  schema: Type.Optional(
    Type.Unknown({
      description:
        "JSON Schema for the subagent's final answer (e.g. {type:'object', properties:{...}}). When set, the child must return via a structured_output call matching this shape instead of prose; the tool result is the JSON-serialized object.",
    }),
  ),
});
```

3. Add a shape-check helper near the top of the file (after `taskPreview`):

```ts
/** Minimal pre-flight check: a JSON-Schema-shaped object needs at least a `type` field. */
function isSchemaShaped(value: unknown): value is TSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value;
}
```

4. In `execute()`, validate `params.schema` right after the `agentType` resolution block (before the worktree block) and pass it through to `spawn()`:

```ts
      if (params.schema !== undefined && !isSchemaShaped(params.schema)) {
        return failEarly(`Invalid schema: expected a JSON-Schema-shaped object with a "type" field.`);
      }
```

And in the `spawn({...})` call, add:

```ts
          schema: params.schema as TSchema | undefined,
```

(right after `retryOnTransient: params.retryOnTransient,`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: PASS — all tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts
git commit -m "feat(pi-agent-ext-workflow): subagent tool supports schema (structured output)"
```

---

## Task 7: Phase 2 docs

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/CONTEXT.md`
- Modify: `bun-apps/pi-agent-ext-workflow/PRD.md`

- [ ] **Step 1: Update CONTEXT.md**

Extend the note added in Task 4 (same location, `subagent` tool's entry):

```markdown
It also accepts `agentType` (resolves via the same `AgentRegistry`
language entry `workflow`'s `agent()` uses — tools/model/prompt/worktree
isolation from a `.pi/agents/*.md` definition, with explicit call-site
`model`/`tools`/`excludeTools` overriding the binding) and `schema`
(structured output via the existing `structured_output` machinery).
```

- [ ] **Step 2: Update PRD.md**

Extend the note added in Task 4:

```markdown
`subagent` also supports `agentType` (named tool/model/prompt/isolation
bindings) and `schema` (structured output) — near-parity with the
`workflow` engine's `agent()` for single-dispatch use, modulo background
execution (see `docs/superpowers/specs/2026-07-19-workflow-control-tool-design.md`
§3.3 — still explicitly out of scope).
```

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/CONTEXT.md bun-apps/pi-agent-ext-workflow/PRD.md
git commit -m "docs(pi-agent-ext-workflow): document subagent agentType + schema support"
```

---

## Task 8: `spawn-subagent.ts` — `onHistory` pass-through

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/spawn-subagent.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/spawn-subagent.test.ts`

`WorkflowAgent.run()` already throttles `onHistory` to at most once per 250ms internally (`src/agent.ts:439-447`, `maybeEmitHistory`), plus one final unconditional emit in its `finally` block (`src/agent.ts:485-489`). `spawnSubagent()` just needs to forward a caller-supplied `onHistory` straight through — no new throttling logic belongs here, since the throttling this plan's spec called for is already satisfied at the source.

- [ ] **Step 1: Write the failing test**

Add to `bun-apps/pi-agent-ext-workflow/tests/spawn-subagent.test.ts`, after the `usage` tests from Task 1:

```ts
  it("onHistory is forwarded to runner.run and fires with what the runner reports", async () => {
    const fixtureHistory = [{ role: "assistant" as const, kind: "toolCall" as const, toolName: "read", text: "{}" }];
    const seen: unknown[] = [];
    const runner = mkRunner(async (p) => {
      (p.opts.onHistory as ((h: typeof fixtureHistory) => void) | undefined)?.(fixtureHistory);
      return "ok";
    });
    await spawnSubagent({
      task: "t",
      agent: runner,
      onHistory: (h) => seen.push(h),
    });
    assert.deepEqual(seen, [fixtureHistory]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/spawn-subagent.test.ts )`
Expected: FAIL — TypeScript rejects the unknown `onHistory` option on `SpawnSubagentOptions` (or, if it type-checks loosely, `seen` stays empty because nothing forwards the callback).

- [ ] **Step 3: Implement**

In `bun-apps/pi-agent-ext-workflow/src/spawn-subagent.ts`:

1. Add the `AgentHistoryEntry` import:

```ts
import type { AgentHistoryEntry } from "./agent-history.js";
```

2. Add `onHistory` to `SpawnSubagentOptions`, right after `externalSignal`:

```ts
  /** Host signal (e.g. tool-call Ctrl+C) that should cancel this call when fired. */
  externalSignal?: AbortSignal;
  /**
   * Compact live snapshot of the child's message/tool history, forwarded
   * verbatim from `WorkflowAgent.run()`'s own `onHistory` (already throttled
   * to ≥250ms there — no additional throttling needed here).
   */
  onHistory?: (history: AgentHistoryEntry[]) => void;
```

3. In `tryOnce()`, add `onHistory: opts.onHistory` to the `runner.run(...)` options object:

```ts
      const out = await runner.run(opts.task, {
        label: "zk-spawn",
        schema: opts.schema,
        instructions: opts.instructions,
        model: opts.model,
        toolNames: opts.tools,
        disallowedToolNames: opts.excludeTools,
        cwd: opts.cwd,
        signal: ac.signal,
        onUsage: (u) => {
          usage = u;
        },
        onHistory: opts.onHistory,
      } as Parameters<WorkflowAgent["run"]>[1]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/spawn-subagent.test.ts )`
Expected: PASS — all tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/spawn-subagent.ts bun-apps/pi-agent-ext-workflow/tests/spawn-subagent.test.ts
git commit -m "feat(pi-agent-ext-workflow): spawnSubagent forwards onHistory for live progress"
```

---

## Task 9: `subagent-tool.ts` — wire live progress to `_onUpdate`

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`

The SDK's partial-result contract (confirmed by `pi-agent-ext-flux2/extensions/pi-flux2.ts`'s existing `onUpdate` usage, and by `tool-execution.js`'s `updateResult(partialResult, isPartial=true)`) is: `_onUpdate({content, details: undefined})` mid-run, and the TUI re-invokes `renderResult(result, {expanded, isPartial: true}, theme, ctx)` with that partial content. `renderResult` needs an `isPartial` branch; `renderCall` is unaffected (the SDK's spinner already conveys "running", per the existing comment in `renderSubagentCall`).

- [ ] **Step 1: Write the failing tests**

Add to `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`, after the `schema` tests from Task 6:

```ts
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

test("renderSubagentResult with isPartial:true renders the streamed text, ignoring details", () => {
  const out = renderSubagentResult(
    { content: [{ type: "text", text: "↳ reading src/foo.ts" }], details: undefined },
    { expanded: false, isPartial: true },
    T,
  );
  assert.equal(out, "↳ reading src/foo.ts");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `updates` stays empty (nothing calls `_onUpdate` yet); `renderSubagentResult`'s `options` type doesn't have `isPartial`, and without a `details` object the current implementation returns the raw text anyway by coincidence for the third test (this one may already pass — confirm after Step 3 that it still does, since the `!d` early-return already returns raw `text`), but the first two must fail before Step 3.

- [ ] **Step 3: Implement**

In `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`:

1. Add the `AgentHistoryEntry` import:

```ts
import type { AgentHistoryEntry } from "./agent-history.js";
```

2. Add a formatting helper near `taskPreview`:

```ts
/** Render the latest compact history snapshot as a one/two-line progress update. */
export function formatSubagentProgress(history: AgentHistoryEntry[], elapsedMs: number): string {
  const last = history[history.length - 1];
  const toolCalls = history.filter((h) => h.kind === "toolCall").length;
  const activity = !last
    ? "…"
    : last.kind === "toolCall"
      ? (last.toolName ?? "tool")
      : last.kind === "toolResult"
        ? `${last.toolName ?? "tool"} → done`
        : last.kind === "text"
          ? (last.text.split("\n")[0] ?? "").slice(0, 60)
          : last.text.slice(0, 60);
  const elapsedS = (elapsedMs / 1000).toFixed(1);
  return `↳ ${activity}\n  ↳ ${elapsedS}s elapsed · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`;
}
```

3. Extend `renderSubagentResult`'s signature and add the `isPartial` branch, right at the top of the function body:

```ts
export function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: SubagentToolDetails },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
): string {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (options.isPartial) {
    // Streaming progress update: the SDK's onUpdate contract carries no
    // `details` yet (mirrors pi-agent-ext-flux2's onProgress usage) — just
    // show the latest line.
    return theme.fg("dim", text);
  }
  const d = result.details;
  if (!d) return text;
  const badge =
    d.status === "done"
      ? theme.fg("success", "✓ done")
      : d.status === "timedout"
        ? theme.fg("warning", "⏱ timedout")
        : theme.fg("error", "✗ failed");
  const usageStr =
    d.usage && d.usage.total > 0 ? ` · $${d.usage.cost.toFixed(3)} · ${d.usage.total} tok` : "";
  const meta = theme.fg("muted", `${d.model ?? "default"} · ${(d.elapsedMs / 1000).toFixed(1)}s${usageStr}`);
  if (!options.expanded) {
    const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
    return `${badge} ${meta} ${theme.fg("dim", truncateToWidth(firstLine, 60))}`;
  }
  return `${badge} ${meta}\n${theme.fg("toolOutput", text)}`;
}
```

(The `const text = ...` line moved above the new `isPartial` branch; everything from `const d = result.details;` down is unchanged from Task 2's version.)

4. Rename the `execute()` parameter from `_onUpdate` to `onUpdate` (it's no longer unused) and wire `onHistory` into `spawn()`, forwarding to it when the caller provided one. The parameter list and the `spawn()` call become:

```ts
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
```

(only the fourth parameter's name changes, from `_onUpdate` to `onUpdate` — everything else in the signature is unchanged from Task 5/6)

```ts
        const result = await spawn({
          task: params.task,
          tools: params.tools ?? agentDef?.tools,
          excludeTools: params.excludeTools ?? agentDef?.disallowedTools,
          model: params.model ?? agentDef?.model,
          cwd: spawnCwd,
          instructions,
          extensionTools: options.getExtensionTools?.(),
          externalSignal: signal,
          timeoutMs: params.timeoutMs,
          retryOnTransient: params.retryOnTransient,
          schema: params.schema as TSchema | undefined,
          onHistory: onUpdate
            ? (history: AgentHistoryEntry[]) => {
                // Progress streaming is diagnostic only — a throwing onUpdate
                // (e.g. a TUI re-render failure) must never fail the subagent's
                // actual task result.
                try {
                  onUpdate({
                    content: [{ type: "text" as const, text: formatSubagentProgress(history, Date.now() - t0) }],
                    details: undefined as unknown as SubagentToolDetails,
                  });
                } catch {
                  // swallowed — see comment above
                }
              }
            : undefined,
        });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: PASS — all tests including the three new ones. Then run the full package suite:

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts
git commit -m "feat(pi-agent-ext-workflow): subagent tool streams live progress via onHistory/_onUpdate"
```

---

## Task 10: Phase 3 docs

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/CONTEXT.md`
- Modify: `bun-apps/pi-agent-ext-workflow/PRD.md`

- [ ] **Step 1: Update CONTEXT.md**

Extend the note added in Tasks 4/7 (same location):

```markdown
While running, `subagent` also streams throttled progress (≥250ms apart,
via `WorkflowAgent.run()`'s existing `onHistory`) through the standard
`_onUpdate`/`renderResult({isPartial: true})` SDK contract, so the TUI
shows the child's latest tool call instead of a bare spinner until
completion. The `/subagents` viewer is unaffected — it still reconstructs
only COMPLETED runs from the session branch (Level-2 "live streaming",
deferred by `2026-07-18-subagent-tui-visibility-design.md`, is this;
the viewer's post-hoc reconstruction is a separate, intentionally
unchanged surface).
```

- [ ] **Step 2: Update PRD.md**

Extend the note added in Tasks 4/7:

```markdown
`subagent` streams live progress while running (throttled, via the SDK's
partial tool-result contract) instead of a bare spinner.
```

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/CONTEXT.md bun-apps/pi-agent-ext-workflow/PRD.md
git commit -m "docs(pi-agent-ext-workflow): document subagent live progress streaming"
```

---

## Final check

- [ ] Run the full package suite one more time end-to-end:

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`
Expected: PASS (this also runs `biome check` + `tsc` build + `bun test`, per `package.json`'s `"test"` script — catches any type error the per-file runs above didn't).
