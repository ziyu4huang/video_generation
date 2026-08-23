# superpowers ↔ workflow subagent bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Yes — this plan dogfoods the very bridge it builds. Until Task 3 lands, SDD dispatch falls back to in-session; that's expected.)

**Goal:** Register a `subagent` tool inside `pi-agent-ext-workflow` (wrapping the existing `spawnSubagent()`) and point superpowers' pi-mapping at it, so SDD / dispatching-parallel-agents can dispatch isolated-context subagents in this repo.

**Architecture:** A thin agent-facing tool (`src/subagent-tool.ts`) maps `{ agent?, task, model?, cwd?, tools?, excludeTools? }` onto `spawnSubagent()` (already used by `zk_card`/`zk_ask`) and returns the child's output + exit/timed-out status. Registered in `extensions/workflow.ts` like the existing `workflow` tool; superpowers' `piToolMapping()` + `pi-tools.md` updated to tell the agent to use it.

**Tech Stack:** TypeScript, TypeBox schemas, `@earendil-works/pi-coding-agent` (`defineTool`, `ToolDefinition`), `bun test` + `node:assert/strict`.

**Source spec:** `.planning/check-and-actually-see-use-context-inspect-tool-/spec.md`
**Source decisions:** tickets `01` (gap, closed) + `02` (Shape A / minimal v1, closed).

## Global Constraints

- **Bun only** — never `node`/`npm`/`npx tsx`. Test via `( cd bun-apps/pi-agent-ext-workflow && bun test )`. (User hard rule.)
- **No top-level `cd`** — the repo blocks it (`no-cd-drift.sh`). Use subshells `( cd … && … )` or `--cwd`.
- **Written artifacts in English**; conversation in zh_TW (CLAUDE.md).
- **superpowers src edits require a rebuild** — its extension runs from `dist/`; after editing `src/*.ts`, run `( cd bun-apps/pi-agent-ext-superpowers && bun run build )`.
- **Minimal v1 only** — do NOT port `clarify`-TUI / `acceptance` / `turnBudget` / `toolBudget` / async / chains. Out of scope (see spec).
- The `subagent` tool name is **owned by workflow in this repo** — installing real `pi-subagents` later would collide; that's a recorded known constraint, not something to guard against here.

---

## File Structure

| File | Responsibility |
|---|---|
| `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts` | **CREATE** — `subagentToolSchema`, `createSubagentTool(options)`, `formatSubagentResult`. The agent-facing tool wrapping `spawnSubagent()`. |
| `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts` | **CREATE** — unit tests: factory shape, param→spawn mapping, success/failure/timeout formatting, extensionTools forwarding (injectable `spawn`). |
| `bun-apps/pi-agent-ext-workflow/tests/extension-subagent-registration.test.ts` | **CREATE** — wiring smoke test: the extension registers a tool named `subagent` at load. |
| `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts` | **MODIFY** — import + register `subagentTool`; thread the shared `extensionTools` capture into it; add its name to the active-tools set. |
| `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` | **MODIFY** — `piToolMapping()` points at the workflow-provided `subagent` tool. |
| `bun-apps/pi-agent-ext-superpowers/skills/using-superpowers/references/pi-tools.md` | **MODIFY** — table row + "Subagents" section point at the workflow `subagent` tool. |
| `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts` | **MODIFY** — update the assertion that pins the mapping text. |

**Interfaces (cross-task contract):**
- **Consumes:** `spawnSubagent(opts: SpawnSubagentOptions): Promise<SpawnSubagentResult>` from `./spawn-subagent.js`, where `SpawnSubagentOptions = { task; tools?; excludeTools?; model?; schema?; instructions?; cwd?; timeoutMs?; retryOnTransient?; extensionTools?; agent? }` and `SpawnSubagentResult = { output: string; exitCode: number; stderr: string; timedOut: boolean }`.
- **Produces:** `createSubagentTool(options): ToolDefinition<typeof subagentToolSchema, { exitCode: number; timedOut: boolean }>`; execute returns `{ content: [{type:"text", text}], details: { exitCode, timedOut } }`.

---

### Task 1: The `subagent` tool — schema, factory, execute

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts`

**Interfaces:** Consumes `spawnSubagent` + its types from `./spawn-subagent.js`; `defineTool` + `ToolDefinition` from `@earendil-works/pi-coding-agent`; `Type` from `typebox`. Produces `createSubagentTool`, `formatSubagentResult`, `subagentToolSchema`.

- [ ] **Step 1: Write the failing tests** — create `tests/subagent-tool.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSubagentTool, formatSubagentResult } from "../src/subagent-tool.js";
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
  const res = await tool.execute("id", { task: "do X", model: "anthropic/claude-sonnet-4", tools: ["read"], agent: "implementer" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(f.calls[0]?.task, "do X");
  assert.equal(f.calls[0]?.model, "anthropic/claude-sonnet-4");
  assert.deepEqual(f.calls[0]?.tools, ["read"]);
  assert.equal(f.calls[0]?.instructions, "Role: implementer");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `Cannot find module '../src/subagent-tool.js'` (file does not exist yet).

- [ ] **Step 3: Write the implementation** — create `src/subagent-tool.ts`:

```ts
/**
 * `subagent` tool — agent-callable single-agent dispatch over `spawnSubagent()`.
 *
 * Closes the Layer-3 drift: superpowers' subagent-driven-development and
 * dispatching-parallel-agents speak in terms of "dispatch a subagent" via the
 * `Subagent (general-purpose):` template; on Pi that resolves to "use an
 * installed `subagent` tool if available". This tool IS that surface, backed by
 * the workflow extension's existing isolated-child runner (WorkflowAgent.run).
 *
 * Minimal v1: { agent?, task, model?, cwd?, tools?, excludeTools? } → child output.
 * No clarify-TUI / acceptance / turnBudget / toolBudget (deferred — see spec.md).
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  spawnSubagent,
  type SpawnSubagentOptions,
  type SpawnSubagentResult,
} from "./spawn-subagent.js";

export interface SubagentToolDetails {
  exitCode: number;
  timedOut: boolean;
}

export const subagentToolSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Informational role/label for the subagent (e.g. 'implementer', 'reviewer', 'researcher'). Forwarded as an instructions prefix; does not change tool selection.",
    }),
  ),
  task: Type.String({
    description:
      "The full, self-contained prompt for the subagent. The child has NO access to this session's history — include everything it needs (goal, context, constraints, and the report format to return).",
  }),
  model: Type.Optional(
    Type.String({
      description:
        "Model override for the child as provider/id (e.g. 'anthropic/claude-sonnet-4', 'google/gemini-3-pro'). Omit to use the session default.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the child. Defaults to the parent session cwd." }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tool allowlist for the child (e.g. ['read','grep','find','ls'] for a read-only explorer). Omit to inherit the default coding toolset.",
    }),
  ),
  excludeTools: Type.Optional(
    Type.Array(Type.String(), { description: "Tool names to deny after the allowlist (e.g. ['edit','write'])." }),
  ),
});

export interface SubagentToolOptions {
  cwd?: string;
  /** Parent-session tools to bridge into the child. Updated by session_start. */
  getExtensionTools?: () => ToolDefinition[] | undefined;
  /** Injectable spawn for tests (defaults to the real spawnSubagent). */
  spawn?: (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
}

/** Format the subagent result into the text the parent agent reads. */
export function formatSubagentResult(result: SpawnSubagentResult): string {
  if (result.exitCode === 0) return result.output;
  const fate = result.timedOut ? "timed out" : "failed";
  const head = `Subagent ${fate} (exit ${result.exitCode}).`;
  const err = result.stderr ? `\n${result.stderr}` : "";
  const tail = result.output ? `\n\n--- subagent output ---\n${result.output}` : "";
  return `${head}${err}${tail}`;
}

export function createSubagentTool(
  options: SubagentToolOptions = {},
): ToolDefinition<typeof subagentToolSchema, SubagentToolDetails> {
  const defaultCwd = options.cwd ?? process.cwd();
  const spawn = options.spawn ?? spawnSubagent;
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Dispatch a single subagent with an ISOLATED context to do a focused task and report back.",
      "The subagent does NOT inherit this session's history — pass a self-contained `task` prompt.",
      "Returns the subagent's output, plus an exit/timed-out status in `details`.",
    ].join(" "),
    promptSnippet:
      "Dispatch an isolated-context subagent for one focused task (implementer / reviewer / researcher). Pass a self-contained `task`; choose `model` per role; restrict with `tools`/`excludeTools`.",
    parameters: subagentToolSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await spawn({
        task: params.task,
        tools: params.tools,
        excludeTools: params.excludeTools,
        model: params.model,
        cwd: params.cwd ?? defaultCwd,
        instructions: params.agent ? `Role: ${params.agent}` : undefined,
        extensionTools: options.getExtensionTools?.(),
      });
      return {
        content: [{ type: "text" as const, text: formatSubagentResult(result) }],
        details: { exitCode: result.exitCode, timedOut: result.timedOut },
      };
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Typecheck + commit**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build 2>/dev/null; bunx tsc --noEmit )` — adjust to the package's actual typecheck (check `package.json` scripts); the goal is "no type errors".
```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts
git commit -m "feat(workflow): add subagent tool wrapping spawnSubagent"
```

---

### Task 2: Register + activate the `subagent` tool in the extension

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/extension-subagent-registration.test.ts` (CREATE)

**Interfaces:** Consumes `createSubagentTool` from Task 1. Produces a registered, always-active `subagent` tool whose `getExtensionTools` reads the same capture the manager uses.

- [ ] **Step 1: Write the failing wiring test** — create `tests/extension-subagent-registration.test.ts`:

```ts
import { describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("workflow extension — subagent tool registration", () => {
  it("registers a tool named 'subagent' at load", async () => {
    const registered: ToolDefinition[] = [];
    const pi = {
      registerTool: mock((t: ToolDefinition) => {
        registered.push(t);
      }),
      on: mock(() => {}),
      events: { on: mock(() => {}), emit: mock(() => {}) },
      getActiveTools: mock(() => [] as string[]),
      setActiveTools: mock(() => {}),
    } as unknown as ExtensionAPI;

    const { default: extension } = await import("../extensions/workflow.js");
    extension(pi);

    const names = registered.map((t) => t.name);
    assert.ok(
      names.includes("subagent"),
      `expected 'subagent' registered; got: ${names.join(", ")}`,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/extension-subagent-registration.test.ts )`
Expected: FAIL — `'subagent' not found in registered tools` (only `workflow`, `workflow_help` register).

- [ ] **Step 3: Wire the tool into the extension** — edit `extensions/workflow.ts`.

3a. Add the import (beside the other `../src/index.js` imports near the top):

```ts
import { createSubagentTool } from "../src/subagent-tool.js";
```

3b. Right after the `workflowHelpTool` registration block (after `pi.registerTool(workflowHelpTool);`), add a shared extension-tools holder + the subagent tool:

```ts
  // Shared holder for parent-session tool definitions, updated in session_start.
  // Both WorkflowManager (for workflow runs) and the subagent tool (for direct
  // dispatches) bridge these into their child sessions so children inherit the
  // parent's extension tools (read/edit/bash + installed extensions).
  const extensionToolsHolder: { current: ToolDefinition[] | undefined } = { current: undefined };
  const subagentTool = createSubagentTool({
    cwd,
    getExtensionTools: () => extensionToolsHolder.current,
  });
  pi.registerTool(subagentTool);
```

3c. In the `session_start` handler, where `extTools` is captured, also feed the holder. Replace:

```ts
    const extTools = (pi as unknown as { getAllToolDefinitions?: () => ToolDefinition[] }).getAllToolDefinitions?.();
    if (extTools?.length) {
      manager.setExtensionTools(extTools);
    }
```

with:

```ts
    const extTools = (pi as unknown as { getAllToolDefinitions?: () => ToolDefinition[] }).getAllToolDefinitions?.();
    if (extTools?.length) {
      manager.setExtensionTools(extTools);
      extensionToolsHolder.current = extTools;
    }
```

3d. Add the subagent tool to the active-tools set. Replace:

```ts
    const wantActive = [workflowTool.name, workflowHelpTool.name];
```

with:

```ts
    const wantActive = [workflowTool.name, workflowHelpTool.name, subagentTool.name];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/extension-subagent-registration.test.ts )`
Expected: PASS.

- [ ] **Step 5: Run the full workflow suite (no regressions) + commit**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test )`
Expected: all green (note: `tests/workflow-tools-available.test.ts` already lists `"subagent"` in `DEFAULT_PI_TOOLS`, so this aligns with an existing fixture assumption).
```bash
git add bun-apps/pi-agent-ext-workflow/extensions/workflow.ts bun-apps/pi-agent-ext-workflow/tests/extension-subagent-registration.test.ts
git commit -m "feat(workflow): register + activate the subagent tool"
```

**Pitfall:** `extension(pi)` constructs `createWorkflowStorage(cwd)` / `WorkflowManager` with `process.cwd()`. The wiring test runs from the package dir so this is safe; if it ever side-effects oddly in CI, isolate by running from a temp cwd. Registration is synchronous at load — `installResultDelivery`/`installTaskPanel`/`installWorkflowEditor` live inside the `session_start` handler and do NOT run during this test.

---

### Task 3: Point superpowers' pi-mapping at the workflow `subagent` tool

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` (`piToolMapping()`)
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/using-superpowers/references/pi-tools.md`
- Modify: `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts` (pin update)

- [ ] **Step 1: Update the failing assertion first (TDD)** — in `tests/bootstrap.test.ts`, replace:

```ts
    expect(payload).toContain("pi-subagents");
```

with:

```ts
    expect(payload).toContain("pi-agent-ext-workflow");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/bootstrap.test.ts )`
Expected: FAIL — payload still contains `pi-subagents`, not `pi-agent-ext-workflow`.

- [ ] **Step 3: Update `piToolMapping()`** — in `src/superpowers.ts`, replace the line:

```ts
Pi does not ship a standard subagent tool. If a subagent tool such as \`subagent\` from \`pi-subagents\` is available, use it for Superpowers subagent workflows. If no subagent tool is available, do the work in this session or explain the missing capability instead of inventing \`Task\` calls.
```

with:

```ts
Pi does not ship a standard subagent tool in core. This repo's \`pi-agent-ext-workflow\` provides a \`subagent\` tool (an isolated-context child via spawnSubagent). Use \`subagent({ task, model, tools, excludeTools, cwd })\` for Superpowers subagent workflows — pass a self-contained \`task\` (the child has no access to this session's history). If no \`subagent\` tool is available, do the work in this session or explain the missing capability instead of inventing \`Task\` calls.
```

- [ ] **Step 4: Update the reference doc** — in `skills/using-superpowers/references/pi-tools.md`:

Replace the table row:

```markdown
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use an installed subagent tool such as `subagent` from `pi-subagents` if available |
```

with:

```markdown
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use the `subagent` tool provided by `pi-agent-ext-workflow` — `subagent({ task, model, tools, excludeTools, cwd })` |
```

And in the **## Subagents** section, replace:

```markdown
Pi core does not ship a standard subagent tool. The `pi-subagents` package is a strong optional companion and provides a `subagent` tool with single-agent, chain, parallel, async, forked-context, and resume/status workflows. If no subagent tool is available, do not fabricate `Task` calls; execute sequentially in the current session or explain that the optional subagent capability is not installed.
```

with:

```markdown
Pi core does not ship a standard subagent tool. This repo's `pi-agent-ext-workflow` provides a `subagent` tool — a single-agent, isolated-context dispatch (`subagent({ task, model, tools, excludeTools, cwd })`) backed by `spawnSubagent()`. It covers SDD's implementer/reviewer dispatch; it does NOT provide chains/parallel/async/clarify in v1. If no `subagent` tool is available, do not fabricate `Task` calls; execute sequentially in the current session or explain that the subagent capability is not installed.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/bootstrap.test.ts )`
Expected: PASS.

- [ ] **Step 6: Rebuild superpowers (src→dist) + commit**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun run build )`
```bash
git add bun-apps/pi-agent-ext-superpowers/src/superpowers.ts bun-apps/pi-agent-ext-superpowers/skills/using-superpowers/references/pi-tools.md bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts
git commit -m "feat(superpowers): point pi-mapping at the workflow subagent tool"
```

**Pitfall:** `getBootstrapContent()` caches the assembled payload per process (`cachedBootstrap`), and the extension runs from `dist/`. So the rebuild (Step 6) is mandatory for the new mapping to reach a live session; `pi-tools.md` is read at runtime and needs no rebuild.

---

### Task 4: End-to-end verification + final whole-branch review

**Files:** none (verification + review).

- [ ] **Step 1: Verify the tool is available to an agent**

Start the agent (or run a one-shot): confirm `subagent` appears in the available tools (e.g. via `inspect_extensions`, or by asking the agent to list its tools). Expected: `subagent` present, source `pi-agent-ext-workflow`.

- [ ] **Step 2: Verify a real isolated dispatch**

Ask the agent to dispatch a trivial subagent, e.g.:

```
Using subagent-driven-development, dispatch one implementer subagent with task:
"Create a file /tmp/sdd-smoke-<random>.txt containing 'hello from subagent', then report Status: DONE."
```

Expected: the `subagent` tool fires, a child session runs in isolated context, the file is created, and the parent receives `Status: DONE`. Confirm the child did NOT inherit the parent's conversation (it only saw the `task`).

- [ ] **Step 3: Verify SDD dispatch no longer falls back**

Confirm the bootstrap now tells the agent to use the `subagent` tool (the `piToolMapping` text from Task 3), not "execute in-session."

- [ ] **Step 4: Final whole-branch review**

Run `scripts/review-package MERGE_BASE HEAD` (or `git diff`) for the branch and dispatch a final code reviewer (most capable model) against the full diff + this plan + the spec. Address Critical/Important findings in one fix subagent; triage Minor from the progress ledger.

- [ ] **Step 5: Finish**

Use `superpowers:finishing-a-development-branch` to merge/PR (user prefers squash-merge; rebase over merge).

---

## Self-Review (against spec.md)

- **Spec coverage:** "register a `subagent` tool inside workflow wrapping spawnSubagent" → Task 1+2. "point superpowers pi-mapping at it" → Task 3. "params {agent,task,model,cwd,tools,excludeTools}" → Task 1 schema. "report-back status stays prompt convention" → Task 1 returns output; status lives in the child's text. "extension-tools bridging" → Task 1 `getExtensionTools` + Task 2 holder wiring. "minimal v1, no clarify/budgets" → Global Constraints + none appear in schema. "E2E: SDD dispatches isolated implementer → DONE" → Task 4. ✅ no gaps.
- **Placeholder scan:** no TBD/TODO; every code step has complete code. ✅
- **Type consistency:** `SpawnSubagentOptions`/`SpawnSubagentResult` match `spawn-subagent.ts`; `ToolDefinition<typeof subagentToolSchema, SubagentToolDetails>` matches the workflow-tool pattern; `extensionToolsHolder.current: ToolDefinition[] | undefined` matches `manager.setExtensionTools`'s input. ✅
