---
type: grilling
status: closed
claimed: chart-session-2026-07-22
---

## Question

Should the `subagent` tool declare an explicit `executionMode`, given pi's **default is parallel** (ticket 03) and the scope decision routes parallel through the `workflow` tool?

Today the tool declares no `executionMode`, so multiple `subagent` calls in one assistant turn run **concurrently by default but uncapped** — each spawns a full in-process `WorkflowAgent` session. That is a latent, undocumented behaviour that conflicts with the "parallel goes through `workflow`'s capped `parallel()`" contract.

Options:
- **A — Declare `executionMode: "sequential"`.** Forces ad-hoc multi-dispatch in one turn to serialize, matching the "parallel via workflow" contract exactly. Simple, predictable; a controller that wants concurrency must use `parallel()`.
- **B — Leave default (parallel) but document + cap.** Allow ad-hoc concurrent dispatch, but add a concurrency cap (like the pi-native ext's `MAX_CONCURRENCY=4`) so N in-process sessions can't explode. More flexible; reintroduces a second concurrency path.
- **C — Declare `sequential` now (A), revisit if a real need for ad-hoc parallel `subagent` dispatch surfaces.**

Decide and document the rationale in `CONTEXT.md` (the `subagent (tool)` entry), since the choice is non-obvious from the code alone.

## First takeable step

Check `defineTool`/`ToolDefinition` for the `executionMode` field wiring; if declaring `sequential` is a one-line addition, prototype A and confirm a 2-call turn serializes.

## Resolution

**A — IMPLEMENTED.** Declared `executionMode: "sequential"` on the `subagent` tool (`src/subagent-tool.ts`, one line + rationale comment), enforced by the pi engine's rule (`pi-agent-core` agent-loop.js:289 — any sequential tool call in a turn ⇒ the whole batch runs serially). Verified SAFE for workflow fan-out: the `workflow` tool's `parallel()`/`agent()` dispatch via a SEPARATE `createAgentSession()` path (`agent.ts:422`), distinct from the `subagent` tool → `spawnSubagent()` path (`subagent-tool.ts:318`) — so the sequential declaration does NOT throttle workflow runs.

- `src/subagent-tool.ts`: `executionMode: "sequential"` + rationale comment.
- `CONTEXT.md`: `subagent (tool)` entry extended with the executionMode rationale (decision 10).
- `tests/subagent-tool.test.ts`: asserts `tool.executionMode === "sequential"`.

Verified: workflow build clean, 1198 tests / 0 fail. Revisit only if a concrete ad-hoc-parallel-`subagent` need surfaces (then option B / a cap).
