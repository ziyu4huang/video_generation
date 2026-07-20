---
type: research
status: closed
closed: 2026-07-20 (resolved by research; no code change)
blocked by: 02, 03
---

# 04 — Sync timing & lifecycle

## Question

WHEN does the unified layer parse + sync (`session_start` full sync? file-watch? `tool_execution_end` after a plan write?), and HOW do auto-managed todos survive `session_compact` / `session_tree` / branch-switch — does goal-todo re-pull the plan AFTER `replayFromBranch(ctx)` (so synced todos survive) or does replay clobber them? Define the ordering (replay first, then re-sync). Verify idempotency + merge-safety across concurrent sessions editing the plan dir.

Adopted + restated from the older effort's ticket 05 for the unified layer.

### Context

- goal-todo hooks: `session_start/compact/tree` → `replaceState(replayFromBranch(ctx))`; `tool_execution_end` → refresh on `todo` success; stale-ctx errors swallowed via `isStaleCtxError`.
- To verify during research: what `tool_execution_end` exposes beyond `toolName` + `isError` (does it carry args / output path to detect a plan write?); whether pi offers any file-watch primitive to extensions.

## Resolution — RESOLVED by research (2026-07-20); no code change

All timing/lifecycle/replay questions are **already implemented + verified** in the ticket-09 build (`core-task.ts`, `coordinator.ts`, `todo-seed.ts`). The yield sub-question (TB5b) is **N/A** in the current architecture. Verified by reading the live code + the pi SDK `ToolExecutionEndEvent` type.

### Q1 — WHEN does the layer parse + sync?

- **`session_start`** — authoritative full sync: `replaceState(replayFromBranch(ctx))` → `refreshPlan(ctx.cwd)` (parse + cache the active effort's plan) → `seedTodoFromPlan(ctx.cwd)`. ✓
- **`tool_execution_end`** — incremental re-parse, gated to mutating tools (`write`/`edit`/`bash`) via `shouldRefreshAfterTool` (TB5a, #719). A non-plan write just triggers a cheap re-parse — acceptable. ✓
- **file-watch** — **not exposed to extensions.** pi uses `fs.watchFile` internally (footer-data-provider) but the `ExtensionAPI` offers only event hooks; there is no FSWatcher/onFileChange primitive. The polling design (session_start + tool_execution_end) is therefore the correct + only approach. ✓
- **`session_compact`/`session_tree`** — deliberately do NOT re-parse/seed: the plan file is unchanged across a compact, and todos survive via replay (below). The plan cache persists in memory. ✓

### Q2 — HOW do todos survive compact / tree / branch-switch? replay ordering?

- **Replay first, then seed.** `session_start` runs `replaceState(replayFromBranch(ctx))` BEFORE `seedTodoFromPlan` — so the seed never clobbers replayed todos. ✓
- **`seedTodoFromPlan` is empty-only** (`getTodos().length > 0 → return false`) — replayed or in-session todos are never overwritten; re-running it is a no-op (idempotent). ✓
- **`session_compact`/`session_tree`** — `replaceState(replayFromBranch(ctx))` (the expected "stale after session replacement" error is swallowed via `isStaleCtxError`) → todos survive via replay. No re-seed (it would no-op — the todo is non-empty after replay). ✓

### Q3 — what does `tool_execution_end` expose?

SDK type (`dist/core/extensions/types.d.ts`): `ToolExecutionEndEvent = { type, toolCallId, toolName, result: any, isError }`. **`args` is NOT on the end event** (it lives on `tool_execution_start`/`_update`); `result` IS. The handler uses `toolName` + `isError` only. A *precise* plan-write gate could inspect `result` for a `.planning/` path, but TB5a's broad tool-name gate is the pragmatic choice (no result-shape coupling); precision is a future option if the broad gate ever proves noisy. Not needed now.

### Q4 — idempotency + merge-safety across concurrent sessions

- `refreshPlan` — per-cwd `Map<cwd, ParsedPlan>` cache; a pure re-parse (idempotent, no side effects).
- `seedTodoFromPlan` — empty-only guard → idempotent.
- Plan file = single source of truth (last-writer-wins on disk); the cache refreshes on the next mutating-tool / session_start, so it is eventually consistent. No merge logic needed (a plan is single-author per session).
- Todos = per-session (each session replays its OWN branch) → no cross-session todo corruption.
- `__piPlan*` readers = pure functions over the cache (idempotent reads).

### Q5 (TB5b) — yield to `__piGoalActive` / `__piWayfindGrill`?

**N/A in the current architecture.** The plan coordinator (core-task) has **no auto-drive to yield**:

- **No system-prompt injection** — core-task has no `before_agent_start` plan-injection. (goal.ts's `before_agent_start` is the GOAL's, active only during `/goal`, and it ADDS plan progress as a feature — not a conflict.)
- **No auto-continue** — only goal.ts auto-continues, and that is the goal's continuation, not the plan's.
- **Publish is passive** — `__piPlan*` is read BY wayfind; it never drives goal/todo.
- **Seed is empty-only** — a grill is conversational (it does not populate the todo); even if a plan exists + the todo is empty at session_start, the seed fills plan-tasks the grill never touches.
- **Gate is user-initiated** — `planningGateBlocking` only fires on `goal_complete`.

**Finding (dangling seam):** wayfind publishes `__piWayfindActive` / `__piWayfindGrill` "so the plan coordinator can yield" — but core-task **never reads either**. `__piWayfindGrill` IS consumed (by hermes-memory's correction-detector), but the plan-coordinator-yield purpose is vestigial: a remnant of the pre-#678 / ADR-0003 design where a plan coordinator injected + auto-continued. The ticket-09 build deliberately chose **publish + gate + seed (no injection)**, so there is nothing to yield.

**Resolution:** TB5b / yield = **N/A**. No code change. The dangling `__piWayfindActive` publish is harmless (a globalThis key no consumer reads) but its comments are misleading. *Optional follow-up* (not a blocker, not part of this ticket): either leave it as a forward-compat no-op, or clean up the publish + correct the comments.

---

**Bottom line:** ticket 04's timing/lifecycle/replay/concurrency questions are settled by the implemented + verified 09 build; yield is N/A. Frontier is now **05 only** (multi-plan, deferred).
