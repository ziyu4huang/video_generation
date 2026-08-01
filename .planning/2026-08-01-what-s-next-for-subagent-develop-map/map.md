# Wayfinder map: 2026-08-01-what-s-next-for-subagent-develop-map

## Destination

A plan-ready **spec** for adding parallel/batch subagent dispatch to the `subagent` capability surface — resolving the primitive **shape**, **safety scope** (read-only fan-out vs general parallel), **concurrency/budget bound**, and **result model** — handed off to `writing-plans`. The build is out of scope; this map produces the decision, not the code.

Origin: an **open survey** (2026-08-01) across the subagent-dev space. The user picked parallel/batch dispatch as the next itch over three runner-up threads — see **Out of scope**.

## Notes

- **Domain**: `bun-apps/pi-agent-ext-subagent` — the `subagent` tool (currently `executionMode: "sequential"` at `src/subagent-tool.ts:449`), the `WorkflowAgent` runner, the write-once run-persistence store, and the `workflow` tool's `parallel()` as the internal precedent for fan-out. The model can only fan out today by dropping to the `workflow` JS DSL; there is no parallel/batch primitive in the model-facing tool palette.
- **Skills every session should consult**: `grilling` + `domain-modeling` for the scope and shape tickets ([02], [03], [04]); `librarian` if provenance on how peer agent-systems expose parallel sub-dispatch is needed beyond [01]'s landscape.
- **Standing preference** (grilled 2026-08-01): this effort is the **parallel-dispatch capability**. Review-cost reduction, parent-model live visibility, and session-aggregated budget/resume were surveyed and **deferred** — separate efforts (Out of scope).
- **Fact freshness**: charted on a detached HEAD fast-forwarded to `origin/main` @ `6867e6ef` (0 behind) — facts current as of charting.

## Decisions so far

- [parallel-dispatch landscape + internal precedent](tickets/01-research-parallel-dispatch-landscape.md) — two layers exist externally (framework orchestration vs tool-execution parallelism); supervisor pattern is the production default; **bounded fan-out is mandatory** (unbounded cascades into rate limits). Internally `workflow.parallel()` (`workflow.ts:617`) already does it — `Promise.all` over `agent()` thunks, partial-failure-tolerant (`null` slots), phase-frozen, worktree-isolated per agent, **no cap at its layer**. Headline: the gap is **exposure, not implementation** — reachable only via the JS DSL today. Leans [03] toward reuse (options b/c) over a from-scratch plural tool (a).
- [safety scope: read-only fan-out MVP](tickets/02-grill-safety-scope-readonly-vs-general.md) — the primitive targets **non-mutating** tasks (research/review/analysis). Verified worktree isolation **discards** commits on teardown (`removeWorktree` force-deletes; "NOT auto-merged"), so general-parallel-mutating needs a re-convergence layer that doesn't exist → deferred as a separate effort; the SDD "never parallel implementers" rule stands. [03] is read-only **by construction**; [04]'s cap/budget still applies.
- [primitive shape + result model](tickets/03-grill-primitive-shape-result-model.md) — a new **`subagents({ tasks, concurrency })`** batch tool, wrapping `parallel()`/`agent()` + `MAX_CONCURRENCY`, keeping the singular `subagent` + its sequential contract intact. **Positional-array** results (`{output,status}`/`null`, echoes optional `id`+index). Read-only **enforced** by excluding `edit`/`write`/`bash` (non-overridable) → safe parallelism in the shared tree. [04] unblocked (cap reuses MAX_CONCURRENCY=16).
- [concurrency cap + budget/backpressure](tickets/04-grill-concurrency-budget-backpressure.md) — cap is precedent-decided (`concurrency` param clamped `[1,16]`, default `defaultConcurrency`, total ≤ `MAX_AGENTS_PER_RUN=1000`). Budget = **per-child HARD** (existing `tokenBudget`/`spendBudget`) + **optional batch SOFT gate** (between-dispatch, never aborts in-flight — mirrors workflow's run-wide gate). Backpressure = positional array, un-dispatched slots return `{status:'budget',exhaustion}`, plus a top-level collective-exhaustion summary. **Spec complete — destination reached.**

## Not yet specified

<!-- fog toward the destination — in scope, not yet sharp enough to ticket -->

- **Live visibility of PARALLEL runs in the `/subagents` TUI.** The in-flight registry handles single runs; a batch of N read-only subagents may need grouping/dedup in the viewer. Suspected, graduates once the `subagents` tool (per [03]) is built.

_([02]'s read-only scope evaporated two earlier fog patches: a shared-state channel for parallel MUTATING tasks — no mutating now; and deprecating the SDD "never parallel implementers" rule — the rule stands. [03] then resolved the "Relationship to `workflow.parallel()`" patch → coexist: the tool wraps `parallel()`/`agent()`, the DSL keeps general orchestration. All three cleared.)_

## Out of scope

<!-- ruled beyond this destination; closed, never graduates -->

- **Parent-model live visibility / mid-flight intervention** — the deferred frontier thread. This map's primitive returns final results per child, exactly as today; only the human TUI sees live progress. Separate effort if pursued.
- **SDD review-cost reduction** (watchdog L1/L2 tuning, auto-skip trivial-diff review, cheaper tiers) — deferred frontier thread; separate effort.
- **Session-aggregated budget across all dispatches + resumable/pausable runs** — deferred frontier thread. Note: the *narrow* batch-level budget question **is** in scope as [04]; the broad session-wide/cross-effort budget and run-resume are not.
- **General parallel for MUTATING implementer tasks + the worktree re-convergence/merge layer** — ruled out by [02] (read-only MVP). Current worktree isolation discards commits on teardown (`removeWorktree` force-deletes; "Results are NOT auto-merged"); a convergence layer must be invented. Separate follow-up effort. The SDD "never parallel implementers" rule stands until that lands.
- **The build itself** — this map delivers a plan-ready spec for `writing-plans`, not the implementation.
