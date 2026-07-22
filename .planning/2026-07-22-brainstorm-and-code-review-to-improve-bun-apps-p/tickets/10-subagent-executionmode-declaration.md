---
type: grilling
status: open
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
