# subagent_runs tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a model-callable `subagent_runs` tool that reads back durable subagent run records (`~/.pi/subagents/runs/<id>.json`), closing the ticket-08 "written but never read" gap so the parent agent can recall cross-session runs.

**Architecture:** A new action-discriminated tool (`list` | `get`) that delegates to the existing `SubagentRunPersistence.list()` / `.load(id)`. Mirrors the `workflow_control` precedent (a second tool alongside the primary). Pure read, no side effects, parallel-safe.

**Tech Stack:** TypeScript (Bun), `typebox`, `@earendil-works/pi-coding-agent` `defineTool`, `bun:test`.

## Global Constraints

- **Bun only** — never node/npm/yarn. Tests: `( cd bun-apps/pi-agent-ext-workflow && bun test )`; typecheck: `bunx tsc`.
- **No top-level `cd`** — use `( cd <dir> && … )`.
- **Explicit `git add <paths>`** — never `git add -A`.
- **CI gate** (`pi-agent-ext-workflow`): `bun run build && bun test` (biome NOT gated).
- **Spec:** `docs/superpowers/specs/2026-07-23-subagent-runs-tool-design.md`.
- **Branch:** `subagent-runs-tool-20260723-2219` (spec already committed).

---

## File Structure

- **Create** `bun-apps/pi-agent-ext-workflow/src/subagent-runs-tool.ts` — schema + `createSubagentRunsTool({ persistence })` + `list`/`get` execute + render helpers.
- **Create** `bun-apps/pi-agent-ext-workflow/tests/subagent-runs-tool.test.ts` — list/get/errors/registration (in-memory fake persistence).
- **Modify** `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts:71-94` — hoist the persistence instance to a shared const; register the new tool (shares the instance).
- **Modify** `bun-apps/pi-agent-ext-workflow/src/index.ts` — re-export `createSubagentRunsTool` (+ type) alongside `createWorkflowControlTool`.

---

## Task 1: subagent-runs-tool.ts — schema + factory + tests (TDD)

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/src/subagent-runs-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-runs-tool.test.ts`

**Interfaces:**
- Consumes: `SubagentRunPersistence` (`{ list(): SubagentRunRecord[]; load(id): SubagentRunRecord | null }`) + `SubagentRunRecord` from `./subagent-run-persistence.js`; `AgentHistoryEntry` (`role/kind/text/toolName?/isError?/timestamp?`) from `./agent-history.js`.
- Produces: `createSubagentRunsTool(options): ToolDefinition` — tool name `subagent_runs`, actions `list` | `get`.

- [ ] **Step 1: Write the failing tests**

Create `tests/subagent-runs-tool.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSubagentRunsTool } from "../src/subagent-runs-tool.js";
import type { SubagentRunRecord, SubagentRunPersistence } from "../src/subagent-run-persistence.js";

function mkRecord(over: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    id: "r1",
    toolCallId: "tc1",
    task: "do the thing",
    model: "zai/glm-5.2",
    cwd: "/repo",
    status: "done",
    exitCode: 0,
    timedOut: false,
    startedAt: "2026-07-23T10:00:00Z",
    elapsedMs: 1500,
    output: "result text",
    ...over,
  };
}

/** In-memory fake persistence (list is newest-first by startedAt, like the real one). */
function fakePersistence(records: SubagentRunRecord[]): SubagentRunPersistence {
  return {
    save: () => {},
    list: () => [...records].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    load: (id) => records.find((r) => r.id === id) ?? null,
    delete: () => false,
    getRunsDir: () => "/tmp/fake",
  };
}

const NO_SIGNAL = undefined as unknown as AbortSignal;

test("list renders runs newest-first with #ordinal + id", async () => {
  const p = fakePersistence([
    mkRecord({ id: "old", startedAt: "2026-07-22T10:00:00Z" }),
    mkRecord({ id: "new", startedAt: "2026-07-23T10:00:00Z" }),
  ]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  assert.equal(text.includes("new"), true, "newest (r=2026-07-23) first");
  assert.equal(text.indexOf("new") < text.indexOf("old"), true, "newest before oldest");
  assert.equal(text.includes("id=new"), true);
});

test("list filters by status", async () => {
  const p = fakePersistence([mkRecord({ id: "ok", status: "done" }), mkRecord({ id: "bad", status: "failed" })]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list", status: "failed" }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  assert.equal(text.includes("id=bad"), true);
  assert.equal(text.includes("id=ok"), false);
});

test("list respects limit", async () => {
  const p = fakePersistence([mkRecord({ id: "a" }), mkRecord({ id: "b" }), mkRecord({ id: "c" })]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "list", limit: 2 }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  assert.equal(text.includes("id=c"), false, "only 2 of 3 (newest-first slice)");
});

test("list empty → clear message", async () => {
  const tool = createSubagentRunsTool({ persistence: fakePersistence([]) });
  const res = await tool.execute("id", { action: "list" }, NO_SIGNAL, undefined, undefined);
  assert.match((res.content[0] as { text: string }).text, /No subagent runs recorded/);
});

test("get found → output + metadata", async () => {
  const p = fakePersistence([mkRecord({ id: "r1", output: "the answer is 42" })]);
  const tool = createSubagentRunsTool({ persistence: p });
  const res = await tool.execute("id", { action: "get", id: "r1" }, NO_SIGNAL, undefined, undefined);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /the answer is 42/);
  assert.match(text, /zai\/glm-5\.2/);
});

test("get not-found → clear message, no crash", async () => {
  const tool = createSubagentRunsTool({ persistence: fakePersistence([]) });
  const res = await tool.execute("id", { action: "get", id: "nope" }, NO_SIGNAL, undefined, undefined);
  assert.match((res.content[0] as { text: string }).text, /No subagent run with id "nope"/);
});

test("get includeHistory:true includes transcript; default omits", async () => {
  const p = fakePersistence([
    mkRecord({
      id: "r1",
      history: [{ role: "assistant", kind: "tool_call", text: "ran grep", toolName: "grep" } as never],
    }),
  ]);
  const tool = createSubagentRunsTool({ persistence: p });
  const without = await tool.execute("id", { action: "get", id: "r1" }, NO_SIGNAL, undefined, undefined);
  const withHist = await tool.execute("id", { action: "get", id: "r1", includeHistory: true }, NO_SIGNAL, undefined, undefined);
  assert.doesNotMatch((without.content[0] as { text: string }).text, /transcript/);
  assert.match((withHist.content[0] as { text: string }).text, /transcript/);
  assert.match((withHist.content[0] as { text: string }).text, /ran grep/);
});

test("get without id throws", async () => {
  const tool = createSubagentRunsTool({ persistence: fakePersistence([]) });
  assert.rejects(() => tool.execute("id", { action: "get" }, NO_SIGNAL, undefined, undefined), /requires id/);
});

test("createSubagentRunsTool → name 'subagent_runs'", () => {
  const tool = createSubagentRunsTool({ persistence: fakePersistence([]) });
  assert.equal(tool.name, "subagent_runs");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-runs-tool.test.ts )`
Expected: FAIL — `Cannot find module '../src/subagent-runs-tool.js'` (file doesn't exist yet).

- [ ] **Step 3: Implement subagent-runs-tool.ts**

Create `src/subagent-runs-tool.ts`:

```ts
/**
 * `subagent_runs` tool — model-callable read-back of durable `subagent`-tool
 * run records (`~/.pi/subagents/runs/<id>.json`, last-N=200). The records are
 * written by the `subagent` dispatch tool on every completed run; this tool is
 * their FIRST reader, letting the parent agent recall cross-session runs (the
 * human `/subagents` viewer reads only the current session branch).
 *
 * Mirrors the `workflow_control` precedent: a second, action-based tool. Pure
 * read, no side effects → parallel-safe (does NOT declare executionMode
 * "sequential", unlike the dispatch tool). Backed by SubagentRunPersistence.
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SubagentRunPersistence, SubagentRunRecord } from "./subagent-run-persistence.js";

const subagentRunsActionEnum = Type.Union([Type.Literal("list"), Type.Literal("get")]);

const statusFilterEnum = Type.Union([
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("timedout"),
  Type.Literal("budget"),
]);

const subagentRunsSchema = Type.Object({
  action: subagentRunsActionEnum,
  limit: Type.Optional(Type.Number({ description: "list: max runs to return (default 10)." })),
  status: Type.Optional(statusFilterEnum),
  cwd: Type.Optional(Type.String({ description: "list: scope to runs with this working directory." })),
  id: Type.Optional(Type.String({ description: "get: run id (required for action 'get')." })),
  includeHistory: Type.Optional(
    Type.Boolean({ description: "get: include the compact tool transcript (default false — can be large)." }),
  ),
});

export interface SubagentRunsToolOptions {
  persistence: SubagentRunPersistence;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function taskPreview(task: string, n = 60): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function fmtTokens(usage: SubagentRunRecord["usage"]): string {
  return usage && usage.total ? String(usage.total) : "—";
}

function renderRunsList(records: SubagentRunRecord[]): string {
  if (!records.length) return "No subagent runs recorded.";
  const lines = records.map(
    (r, i) =>
      `#${i + 1}  [${r.status}]  ${r.model}  ·  ${taskPreview(r.task)}  ·  ${r.startedAt}  ·  ${Math.round(r.elapsedMs)}ms  ·  ${fmtTokens(r.usage)} tok  ·  id=${r.id}`,
  );
  return [`Recent subagent runs (${records.length}):`, ...lines].join("\n");
}

function renderRun(record: SubagentRunRecord, includeHistory: boolean): string {
  const lines = [
    `# subagent run ${record.id}`,
    `status: ${record.status}  ·  model: ${record.model}  ·  started: ${record.startedAt}  ·  ${Math.round(record.elapsedMs)}ms  ·  ${fmtTokens(record.usage)} tok`,
    `task: ${record.task}`,
  ];
  if (record.report) lines.push(`sdd: ${record.report.status ?? "?"}`);
  if (record.scopeCheck?.outOfScope?.length) lines.push(`scope violations: ${record.scopeCheck.outOfScope.join(", ")}`);
  if (record.budget) lines.push(`budget: ${record.budget.kind} ${record.budget.actual}/${record.budget.limit}`);
  lines.push("", "## output", record.output || "(empty)");
  if (includeHistory && record.history?.length) {
    lines.push("", "## transcript");
    for (const h of record.history) {
      const label = h.toolName ? `${h.kind}:${h.toolName}` : h.kind;
      lines.push(`- [${label}] ${h.text.slice(0, 200)}`);
    }
  }
  return lines.join("\n");
}

export function createSubagentRunsTool(
  options: SubagentRunsToolOptions,
): ToolDefinition<typeof subagentRunsSchema, undefined> {
  const { persistence } = options;
  return defineTool({
    name: "subagent_runs",
    label: "SubagentRuns",
    description:
      "Read back historical subagent-tool runs (cross-session, from ~/.pi/subagents/runs). action 'list' returns recent runs (newest-first; optional status/cwd filter, limit); action 'get' returns one run's full output + metadata by id (includeHistory for the compact transcript). Read-only — completed records, not live runs.",
    promptSnippet:
      "Recall past subagent runs: subagent_runs({ action: 'list' [, status, cwd, limit] }) for recent runs, subagent_runs({ action: 'get', id }) for one run's output.",
    parameters: subagentRunsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      switch (params.action) {
        case "list": {
          let records = persistence.list();
          if (params.status) records = records.filter((r) => r.status === params.status);
          if (params.cwd) records = records.filter((r) => r.cwd === params.cwd);
          const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(0, Math.floor(params.limit)) : 10;
          return textResult(renderRunsList(records.slice(0, limit)));
        }
        case "get": {
          if (!params.id) throw new Error("subagent_runs: action 'get' requires id");
          const record = persistence.load(params.id);
          if (!record) return textResult(`No subagent run with id "${params.id}".`);
          return textResult(renderRun(record, params.includeHistory === true));
        }
        default:
          throw new Error(`subagent_runs: action "${params.action}" not implemented`);
      }
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-runs-tool.test.ts )`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-workflow && bunx tsc )`
Expected: EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-runs-tool.ts bun-apps/pi-agent-ext-workflow/tests/subagent-runs-tool.test.ts
git commit -m "feat(workflow): subagent_runs tool — model-callable read-back of durable runs

New action-based tool (list|get) backed by SubagentRunPersistence — the
FIRST reader of the ticket-08 run records (~/.pi/subagents/runs, written
every dispatch but never read). Mirrors the workflow_control precedent: a
second, pure-read tool alongside the dispatch tool. list returns a compact
newest-first digest (status/model/task/when/tokens/id, optional status &
cwd filter, limit); get returns one run's output + metadata by id
(includeHistory for the compact transcript, default off — can be large).

Read-only, no side effects, parallel-safe (no executionMode:'sequential')."
```

---

## Task 2: register + export + schema-cost check

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts` (hoist persistence to shared const; register tool)
- Modify: `bun-apps/pi-agent-ext-workflow/src/index.ts` (re-export)

**Interfaces:**
- Produces: the tool is live in the workflow extension (registered alongside `subagent`/`workflow_control`), sharing the persistence instance so a `save` by the dispatch tool is visible to a `list`.

- [ ] **Step 1: Register the tool (share the persistence instance)**

In `extensions/workflow.ts`, hoist the persistence instance out of the `createSubagentTool` call into a shared const, then register the new tool.

(a) Add the import (near line 26, the existing `createSubagentTool` import):
```ts
import { createSubagentRunsTool } from "../src/subagent-runs-tool.js";
```

(b) Hoist + register. Replace the block:
```ts
  const subagentTool = createSubagentTool({
    cwd,
    getExtensionTools: () => extensionToolsHolder.current,
    getMainModel: () => manager.getMainModel(),
    inFlight: subagentInFlight,
    persistence: createSubagentRunPersistence(),
  });
```
with:
```ts
  // Shared persistence: the dispatch tool writes; subagent_runs reads.
  const subagentPersistence = createSubagentRunPersistence();
  const subagentTool = createSubagentTool({
    cwd,
    getExtensionTools: () => extensionToolsHolder.current,
    getMainModel: () => manager.getMainModel(),
    inFlight: subagentInFlight,
    persistence: subagentPersistence,
  });
```

(c) Register the new tool right after `pi.registerTool(subagentTool);` and before the `workflowControlTool` line:
```ts
  pi.registerTool(subagentTool);
  const subagentRunsTool = createSubagentRunsTool({ persistence: subagentPersistence });
  pi.registerTool(subagentRunsTool);
```

- [ ] **Step 2: Re-export from index.ts**

In `src/index.ts`, alongside the existing `export { createWorkflowControlTool } from "./workflow-control-tool.js";` (line ~125), add:
```ts
export { createSubagentRunsTool } from "./subagent-runs-tool.js";
export type { SubagentRunsToolOptions } from "./subagent-runs-tool.js";
```

- [ ] **Step 3: Typecheck + full suite**

Run:
```bash
( cd bun-apps/pi-agent-ext-workflow && bunx tsc && bun test )
```
Expected: `tsc` EXIT 0; full suite `0 fail` (was 1244 pass after PR #768; now +9 tests).

- [ ] **Step 4: Schema-cost check (project convention)**

Confirm the new tool's per-request schema cost is small (same shape as `workflow_control`: 1 action union + 4 optional scalars). Best-effort — if the `schema-cost` CLI can't load extensions in this worktree (known research-tool link issue), run it from the primary worktree or inspect-by-shape:

Run (best-effort): `( cd bun-apps/pi-agent-cli && bun src/cli.ts schema-cost 2>&1 | grep -iE "subagent_runs|workflow_control" | head )`
Expected: `subagent_runs` cost comparable to `workflow_control` (both small action tools). If it is surprisingly large, slim the schema (drop `cwd`, trim descriptions) and re-check before committing.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/extensions/workflow.ts bun-apps/pi-agent-ext-workflow/src/index.ts
git commit -m "feat(workflow): register subagent_runs tool + share persistence instance

Register the new read-back tool in the workflow extension alongside the
subagent dispatch tool, sharing ONE SubagentRunPersistence instance so a
run saved by dispatch is immediately visible to a subagent_runs list/get.
Re-export createSubagentRunsTool from the package entry for peer use."
```

---

## Final Verification (after both tasks)

- [ ] **V1: build + full suite**
```bash
( cd bun-apps/pi-agent-ext-workflow && bunx tsc && bun test )
```
Expected: EXIT 0 / 0 fail.

- [ ] **V2: diff sanity** — `git diff origin/main --stat` shows ONLY: `src/subagent-runs-tool.ts` (new), `tests/subagent-runs-tool.test.ts` (new), `extensions/workflow.ts`, `src/index.ts` (+ spec/plan docs). Nothing swept in.

- [ ] **V3: push + PR**
```bash
git push -u origin subagent-runs-tool-20260723-2219
gh pr create --base main --title "feat(workflow): subagent_runs tool — read back durable runs" --body "<body>"
```
