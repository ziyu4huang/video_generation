# subagents visibility finish (deficits 3 + 4a) — spec

> Plan-ready synthesis of the 2026-08-01 grilling session. Continues the live-visibility effort (#988, merged) by closing the two deficits it explicitly deferred.

## Goal

Finish the `/subagents` + inline visibility story for `subagents` batch-tool children:
- **(3)** kill the batch tool's **blind spinner** — its own call (Ctrl-O) shows generic "doing…" with no progress.
- **(4a)** show **full k/N progress** — completed children leave the registry today, so the batch header counts *running* children only, never "done".

## Background — the fog, grounded in code

#988 shipped live grouping (deficit 1+2: forwarded `onModelResolved`/`onHistory`, added `batchId`, collapsible `▼ subagents batch · k running` header). It deferred 3+4. Both are confirmed present on `main`:

| # | Deficit | Code evidence |
|---|---------|---------------|
| **3** | Batch tool's own call is a **blind spinner** — `_onUpdate` is ignored, no `renderCall`/`renderResult` defined | `subagents-tool.ts:168` — `execute(toolCallId, params, _signal, _onUpdate, _ctx)`; the tool body defines neither renderer |
| **4a)** | Completed children are **removed from the registry** the instant they finish → the batch header can only ever count running children | `subagents-tool.ts:243` — `options.inFlight?.end(childRunId)` on each child's completion |

## Decisions (resolved via grilling — all confirmed the recommendation)

- **D1 — Scope:** Close deficits **(3)** + **(4a)**. Defer **(4b)** (post-batch Completed-section visibility via durable-record reconstruction) as a separate effort.
- **D2 — 4a lifecycle:** Completed children **stay in the registry** with a `status: "running" | "completed"` field. Header shows `k running / N done`. A finished child remains selectable (follow shows its frozen trace) until the **whole batch ends**, then the batch's children are evicted together. Backward-compatible (same optional-field pattern as `batchId`).
- **D3 — 3 spinner:** Wire `onUpdate` to a **single-line** `subagents · k/N running · latest: <action>`. The `/subagents` panel already has the rich per-child live view; inline Ctrl-O stays minimal.

## In scope

- Add `status?: "running" | "completed"` to `InFlightSubagent` (`start()` defaults to `"running"`).
- On each batch child's completion: **set `status: "completed"` instead of `end()`-ing it**; keep it in the registry (selectable, frozen trace).
- When the batch tool's `execute()` returns (batch done): **evict all of the batch's children** from the registry (the per-batch cleanup).
- Batch header: count running vs completed → render `▼ subagents batch · k running / N done` (was `k running`); completed children render under the header (greyed/checkmarked), still selectable.
- Wire the batch tool's `onUpdate` → emit a single-line summary derived from the registry: `{running}/{total} running · latest: <most-recently-updated batch child's summarized action>`.

## Out of scope (deferred — separate effort)

- **(4b)** Post-batch Completed-section visibility (durable-record read + `reconstructSubagentRuns` widening + `subagents-command` wiring). `reconstructSubagentRuns` still filters `toolName === "subagent"` only.
- Multi-line merged inline feed (deficit 3 richness upgrade — D3 chose single-line).
- Per-child live action in the `/subagents` *panel* (already shipped in #988).

## Implementation surface

- **`src/subagent-in-flight.ts`** — add `status?: "running" | "completed"` to `InFlightSubagent`; `start()` sets `"running"`. Expose status through whatever `entries()` reads (the viewer + the batch tool's onUpdate both consume the registry).
- **`src/subagents-tool.ts`** —
  - **4a:** replace the per-child `end(childRunId)` on completion with `status: "completed"`; add a per-batch cleanup that ends all the batch's children when `execute()` resolves (success or failure — wrap in try/finally).
  - **(3):** rename `_onUpdate` → `onUpdate`; on each forwarded `onHistory` (or a throttled cadence), emit the single-line summary built from the registry's batch children.
- **`src/subagent-viewer.ts`** —
  - Header count: `k running` → `k running / N done` (count by status across the batch's children).
  - Render: completed-status children appear under the header (greyed/checkmarked), still selectable → follow shows frozen trace.
  - `entries()` batch group must **include** completed-status children (don't filter them out), or the header can't count them. Singular-tool children (no `batchId`) stay flat — byte-identical to today.
- **Tests** — `subagent-in-flight.test.ts` (+status field), `subagents-tool.test.ts` (keep-on-complete + evict-on-batch-end + onUpdate single-line), `subagent-viewer.test.ts` (header k/N + completed-child render/select).

## Acceptance criteria

1. During a running batch, the header shows `▼ subagents batch · k running / N done`; as children finish, `k` decreases and "done" increases (was `k running` only).
2. A completed child remains **selectable** under the header (greyed/checkmarked); selecting it + enter → `follow` shows its **frozen** trace (not removed).
3. The batch tool's own call (Ctrl-O) shows a **live single-line** `subagents · k/N running · latest: <action>` instead of a blind spinner; it updates as children progress.
4. When the batch ends, **all** its children are evicted from the registry — no leak across batch calls.
5. Singular-tool dispatches (no `batchId`, no `status`) render **exactly as before** — no regression in cursor, filter, cap, header, or follow.
6. All existing viewer / in-flight / batch-tool tests stay green; new tests cover each behavior above.

## Footguns (carried into the plan)

- **Shared singleton** → `status` must be optional; singular tool + subprocess + obsidian paths leave it undefined (treated as legacy/running). Never assume it is set.
- **Don't evict per-child on completion** — that re-creates deficit 4a. Eviction is per-**batch**, at `execute()` return (wrap in try/finally so a mid-batch failure still cleans up).
- **`entries()` batch group must include completed children** — if the plan's grouping filters them out, the header can't count "done". The Task-2-style "render groups, entries stays flat" discipline from #988 still applies; the only shape change is counting by status.
- **onUpdate cadence** — `onHistory` fires per child per step; the single-line summary must be cheap to build (derive from the registry, don't rebuild heavy state). The plan should consider throttling if churn is high.
- **"latest action" source** — either scan the batch's children for the most-recently-updated, or track a per-batch "last action" field in `onHistory`. Plan decides; keep it O(batch size) or better.
- **"done" is outcome-agnostic** — a child counts as "done" whether it succeeded, errored, timed out, or hit budget. Per-child outcome stays visible on selection (the frozen trace + the batch result array), not in the header count.
- **Registry growth is bounded + transient** — at most the batch size (≤ `MAX_BATCH_TASKS` = 1000) during a batch, then evicted. No unbounded accumulation.
