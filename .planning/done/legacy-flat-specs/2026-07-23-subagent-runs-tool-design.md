# subagent_runs tool — model-callable read-back of durable runs (design)

**Date:** 2026-07-23
**Branch:** `subagent-runs-tool-20260723-2219` off `origin/main` (`3516e713`)
**Owner:** Ziyu Huang
**Depends on:** ticket-08 `SubagentRunPersistence` (`src/subagent-run-persistence.ts`) — already shipped (write-only to date).

## 1. Goal

The `subagent` tool persists every completed run to
`~/.pi/subagents/runs/<id>.json` (last-N=200, write-once, atomic) via
`SubagentRunPersistence.save()`. **Nothing reads those records back.** The
human `/subagents` viewer reconstructs runs from the **current session branch**
(`subagent-viewer.ts`), not the durable files — so cross-session runs are
write-only in practice.

This design closes that gap with a **model-callable read surface** — a new
`subagent_runs` tool — so the parent agent can recall historical subagent runs
across sessions ("what did the subagent conclude last time about X?").

## 2. Scope

**In scope:**

- New `src/subagent-runs-tool.ts` — `createSubagentRunsTool({ persistence })`,
  action-discriminated (`list` | `get`), backed by the existing
  `SubagentRunPersistence.list()` / `.load(id)`.
- Register it in `extensions/workflow.ts` alongside the `subagent` tool,
  sharing the same persistence instance.
- Export `createSubagentRunsTool` (+ types) from `src/index.ts`.
- A compact render for `list` (table-ish digest) and `get` (the run's output +
  metadata).
- Tests: list (filter/limit/newest-first/empty), get (found/not-found/
  includeHistory), registration.

**Out of scope (YAGNI):**

- Write / delete actions — records are write-once; deletion stays manual/fs.
- Full-text search across run outputs — `list` + `get` covers the recall case.
- Changing the `/subagents` human viewer — it stays session-scoped; this tool
  is the durable cross-session read.
- Streaming / live status — reads are completed records, not in-flight runs
  (those are `subagentInFlight`, a separate layer).

## 3. Background — the read-back gap

| Layer | Writes | Reads (consumer) |
| --- | --- | --- |
| `SubagentRunPersistence` (`~/.pi/subagents/runs/<id>.json`) | `subagent-tool.ts` on every completed run | **NONE** (this design adds the first) |
| `subagentInFlight` | live dispatches | `/subagents` live panel, `subagents-command.ts` |
| session branch | tool results | `/subagents` viewer (`subagent-viewer.ts`) — current session only |

`SubagentRunPersistence` already exposes a complete read API (`list()`
newest-first, `load(id)`, `delete(id)`, `getRunsDir()`) and is injected into
the `subagent` tool at `extensions/workflow.ts:76`. The read methods are simply
never called — this design adds the consumer.

## 4. Surface — new `subagent_runs` tool

Mirrors the established `workflow_control` precedent (a second, action-based
tool alongside the primary one). Pure read, no side effects → does NOT declare
`executionMode: "sequential"` (the dispatch tool does, to force fan-out through
`workflow`; a read has no such concern and is parallel-safe).

### 4.1 Schema

```ts
const subagentRunsActionEnum = Type.Union([
  Type.Literal("list"),
  Type.Literal("get"),
]);

const subagentRunsSchema = Type.Object({
  action: subagentRunsActionEnum,
  // list — optional filters
  limit: Type.Optional(Type.Number({ description: "Max runs to return (default 10)." })),
  status: Type.Optional(
    Type.Union([Type.Literal("done"), Type.Literal("failed"), Type.Literal("timedout"), Type.Literal("budget")],
      { description: "Filter by run status." }),
  ),
  cwd: Type.Optional(Type.String({ description: "Scope to runs in this working directory." })),
  // get — required for action:"get"
  id: Type.Optional(Type.String({ description: "Run id (required for action:'get')." })),
  includeHistory: Type.Optional(Type.Boolean({
    description: "Include the compact tool transcript (default false — can be large).",
  })),
});
```

### 4.2 `action: "list"`

Returns recent runs newest-first (by `startedAt`), after optional filters
(`status`, `cwd`) and `limit` (default 10). Renders a compact digest — one line
per run: `#ordinal  status  model  taskPreview  startedAt  elapsedMs  tokens`.

### 4.3 `action: "get"`

Loads one run by `id`. Returns the run's full `output` (the text the parent
agent originally read) + key metadata (`status`, `model`, `startedAt`,
`elapsedMs`, `usage`, and `report`/`scopeCheck`/`budget` when present). The
compact transcript (`history`) is omitted unless `includeHistory: true` (it can
be large).

### 4.4 Errors

- `action: "get"` without `id` → throw `Error("subagent_runs: action 'get' requires id")`.
- Unknown `id` → a clear "no run with id '<id>'" result (not a crash).
- Persistence fs errors → already swallowed by `SubagentRunPersistence` (returns
  `null` / `[]`); the tool surfaces empty, never throws over a read error.

## 5. Cost — schema-cost (project convention: measure before surface change)

This adds one tool to the workflow extension's surface. The schema is the same
shape as `workflow_control` (action enum + id/limit/status/includeHistory) —
small. The memory's "measure-first" convention targets micro-optimizations of
an already-tuned surface (help-tool splits, prompt-guide); this is a **net-new
capability** with a clear precedent, a different category.

**Task 0 of the plan measures the delta** (via `estimateToolCost` from
`@repo/pi-agent-ext-power-tool/schema-cost`, comparing the new tool's cost to
`workflow_control`'s). If the delta is surprisingly large, slim the schema
(drop `cwd` filter, trim descriptions) before shipping. Precedent:
`workflow_control` was accepted at this size.

## 6. Alternatives considered

1. **Extend the `subagent` tool with an `action` param** (dispatch | list | get).
   Rejected — `task` is currently required; a list/get mode needs no task,
   breaking the "task required" contract and making the schema ambiguous (which
   params apply to which action?). A separate tool keeps each schema focused.
2. **Extend `/subagents` to read durable runs** (human-only). Rejected — the
   goal is a **model-callable** surface (parent agent recalls); the human viewer
   already exists for the current session.
3. **A `count` / `delete` action.** YAGNI — list+get covers recall; records are
   write-once.

## 7. Testing strategy

Uses the existing injectable persistence (`CreateSubagentRunPersistenceOptions`
`fsOverride` / in-memory fakes) — no real filesystem.

- **list**: newest-first ordering; `status` filter; `limit`; `cwd` filter;
  empty when no runs.
- **get**: found (full output + metadata); not-found (clear result, no crash);
  `includeHistory: true` includes the transcript, default omits it.
- **registration**: `createSubagentRunsTool` produces a tool named
  `subagent_runs`; the persistence instance is shared (a `save` via the dispatch
  tool is visible to a subsequent `list`).
- **errors**: `get` without `id` throws.

## 8. Rollout

Single PR, single package (`pi-agent-ext-workflow`):

1. `feat(workflow): subagent_runs tool — model-callable read-back of durable runs`

CI gate: `bun run build && bun test`. Then register/verify in
`extensions/workflow.ts` (the registration is in-package, same PR).

## 9. Risks

- **Schema-cost tax**: a permanent per-request cost for a rarely-used read.
  Mitigation: Task-0 measurement; slim schema if needed; the precedent
  (`workflow_control`) shows a read/control tool at this size is acceptable.
- **Stale data**: records are write-once snapshots — a `get` returns the
  *historical* output, which may be outdated vs. the current repo. The render
  includes `startedAt` so the caller can tell it is historical.
