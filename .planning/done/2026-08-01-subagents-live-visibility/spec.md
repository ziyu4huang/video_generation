# subagents live-visibility — spec

> Plan-ready synthesis of the 2026-08-01 grilling session. Source map/deferred item: `.planning/2026-08-01-what-s-next-for-subagent-develop-map/map.md` (deferred prize #5 + the live-update half of #2).

## Goal

Make `/subagents` show `subagents` batch-tool children **live and grouped**, instead of N static orphan rows that never update and churn as concurrency rotates them.

## Background — the fog, grounded in code

The singular `subagent` tool (`src/subagent-tool.ts`) wires three live surfaces via `spawnSubagent`'s callbacks; the batch tool (`src/subagents-tool.ts`) wires **none** of them. This produces four deficits:

| # | Deficit | Code evidence |
|---|---------|---------------|
| **1** | No `onModelResolved`/`onHistory` forwarded → batch children are **static** rows (no resolved model, no activity trace, `toolCalls`=0, unfollowable — `follow` shows an empty trace) | `mergeReadOnlyExclusion()` builds spawn opts without the callbacks; only `inFlight.start({model, taskPreview, startedAt})` + `end()` are called |
| **2** | No grouping → N flat rows churn in the Running section as concurrency rotates children | `SubagentViewer.entries()` flattens all in-flight runs; no batch concept |
| **3** *(deferred)* | Batch tool's own call is a **blind spinner** (no `onUpdate`, no `renderCall`/`renderResult`) | `createSubagentsTool` defines neither renderer |
| **4** *(deferred)* | **Completed batch children are invisible** — `reconstructSubagentRuns` filters `toolName === "subagent"` only; the batch emits one `subagents` result; its N child durable records (`~/.pi/subagents/runs/`) are never read | `subagent-viewer.ts:reconstructSubagentRuns`; `subagents-command.ts` builds `runs` from the branch only |

## Decisions (resolved via grilling — all confirmed the recommendation)

- **D1 — Scope:** Live-only. Close deficits **(1)** + **(2)**. Defer **(3)** blind-spinner and **(4)** completed-invisible as separate efforts.
- **D2 — Shape:** Collapsible `▼ subagents batch · k running` header → expand to N indented child rows → select a child → the **existing** `follow` view (now usable, since deficit 1 populates its trace). No new sub-view.
- **D3 — Correlation:** Add an **optional `batchId`** to `InFlightSubagent`; the batch tool sets `batchId: toolCallId` (its own tool-call id); the viewer groups non-undefined `batchId`s; singular-tool children stay `undefined` → flat, as today.

## In scope

- Forward each batch child's `onModelResolved` → `inFlight.updateModel(childRunId, id)` and `onHistory` → `inFlight.update(childRunId, history)`.
- Add `batchId?: string` to `InFlightSubagent`; batch tool sets it on `inFlight.start`.
- Viewer: group Running entries by `batchId`; render a collapsible header (expanded-by-default) with indented children; preserve flat rendering for ungrouped runs.

## Out of scope (deferred — separate efforts)

- **(3)** Inline Ctrl-O batch progress (the blind-spinner fix — merges N live history streams into one `onUpdate`).
- **(4)** Completed batch-child visibility (durable-store read + completed-section grouping).
- Full **k/N progress** in the header (done children leave the registry under this MVP, so the header counts *running* children only).

## Implementation surface

- **`src/subagent-in-flight.ts`** — add `batchId?: string` to `InFlightSubagent` (optional → backward-compatible; the registry is a shared singleton across extensions, so singular-tool and workflow paths are unaffected).
- **`src/subagents-tool.ts`** — in `execute()`'s per-child loop: set `batchId: toolCallId` on `inFlight.start`; forward the two callbacks at the **spawn call site** (NOT inside `mergeReadOnlyExclusion`, which is pure and lacks `inFlight`/`childRunId` scope).
- **`src/subagent-viewer.ts`** — Running-section grouping + collapsible header render + collapse/expand input. Cursor, filter, and cap logic must stay byte-identical for ungrouped (`batchId` undefined) entries.

## Acceptance criteria

1. A batch of N children renders **one** `▼ subagents batch · k running` header + k child rows in `/subagents` — not N orphan rows.
2. Each batch-child row shows the **live resolved model** + activity trace + tool-call count (was static; `toolCalls` was 0).
3. Selecting a batch child + enter → `follow` streams its live trace (was empty / unfollowable).
4. Enter on the batch header **collapses** (children hidden, `▶ … k running`); enter again **expands**.
5. Singular-tool dispatches (no `batchId`) render **exactly as before** (flat) — no regression in cursor, filter, cap, or follow.
6. All existing viewer / in-flight / batch-tool tests stay green; new tests cover each behavior above.

## Footguns (carried into the plan)

- **Done children leave the registry** → the header counts *running* children, not full k/N. By design (deficit 4 deferred).
- **Shared singleton** → `batchId` must be optional; never assume it is set.
- **`mergeReadOnlyExclusion` is pure** → callbacks are spread at the `execute()` call site, not added inside it.
- **`entries()` drives cursor + render + filter + cap** → the grouping refactor must keep ungrouped entries byte-identical to today, or existing cursor/filter/cap/follow tests break. (Plan Task 2 keeps `entries()` flat and groups during *render*; Task 3 introduces a selectable header + collapse state, which is the only place `entries()` shape changes.)
- **Contiguity assumption** → batch children of one batch are inserted into the registry together (the batch tool starts them in dispatch order; `executionMode: "sequential"` means a batch and a singular dispatch never run in the same turn). Transition-based render grouping is correct for the actual execution model; a future concurrent-multi-batch scenario would need robust grouping (noted, not built).
