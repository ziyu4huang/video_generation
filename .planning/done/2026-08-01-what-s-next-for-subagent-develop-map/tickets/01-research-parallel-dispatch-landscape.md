## Question

What does the landscape of **parallel/batch sub-dispatch** look like — both outside and inside this repo — so the shape decision ([03]) rests on fact, not intuition?

Two halves:

1. **External**: How do comparable agent frameworks/systems expose parallel fan-out to the *model* (not just the orchestrator)? Survey the shapes: a plural/batch tool, a fan-out array param on an existing tool, a lightweight orchestration primitive, a map/queue construct. For each, note the **safety model** (read-only vs mutating), the **concurrency bound** (fixed cap, caller param, config), and the **result-aggregation** pattern (array, streamed, first-of). Candidates worth a look: Claude Code's Task tool semantics, OpenAI Codex/Agents SDK concurrency, LangGraph parallel branches, AutoGen GroupChat, CrewAI crew kickoff, Google ADK parallel agents — whichever are reachable.
2. **Internal precedent**: How does this repo's own `workflow` tool `parallel()` already fan out subagents under the hood (in `pi-agent-ext-workflow`)? What does it reuse from `WorkflowAgent`/`spawnSubagent`, how does it bound concurrency, and how does it gather results? This is the most direct precedent for any tool-level primitive — what can be lifted vs. what's DSL-specific?

Resolved by a research pass: `web_search`/`fetch_content` for the external landscape, plus reading `pi-agent-ext-workflow`'s `parallel()` implementation for the internal half. Findings recorded as the resolution. This ticket is **AFK** — no human decision in it; it feeds [03].

type: research
blocked by: _(none — the frontier's factual foundation)_

---

## Resolution

status: closed (research pass, 2026-08-01)

### External landscape — two distinct layers

1. **Framework orchestration** (fan-out as graph/chat topology): LangGraph `Send`/parallel branches (fan-out → fan-in nodes), AutoGen actor message-passing, CrewAI supervisor↔crew, and the **supervisor pattern** converging as the production default across LangGraph / Claude Agent SDK / OpenAI Agents SDK (orchestrator delegates to specialized workers, results fan back in).
2. **Tool-execution-layer parallelism** (parallel tool calls within one LLM turn): an orchestration layer decides which calls in a turn can run concurrently, enforces **per-integration concurrency caps**, merges partial failures, and **collects results in original (positional) order** for the API. Default is often **sequential** (`tool_concurrency_limit = 1`) to dodge races; thread pools (e.g. `_MAX_TOOL_WORKERS = 8`) when parallel.

### Cross-cutting findings (load-bearing for [03]/[04])

- **Bounded fan-out is non-negotiable.** Unbounded spawn (one agent per item, instantly) risks API rate-limit cascades (e.g. Anthropic Tier 1 ≈ 50 RPM) and cascading failure. **Bounded batch dispatch** (fixed-size batches) is the recommended pattern. → feeds [04]'s concurrency-cap decision.
- **Fixed per-subagent context cost (~20k tokens)** — fan-out is a real cost multiplier; a collective budget ([04]) matters.
- **Result model norm**: positional array, original order, with per-slot failure tolerated. Matches our internal precedent below.

### Internal precedent — `workflow.parallel()` (the headline)

`pi-agent-ext-workflow/src/workflow.ts:617` — `parallel(thunks: Array<() => Promise<unknown>>)`:

- **`Promise.all` over `agent()` thunks** — reuses the *same* `WorkflowAgent`/`agent()` runner. It is **not** a separate dispatch path; the parallelism is thin glue over the existing single-agent runner. (Note: thunks must be functions, not promises — execution is deliberately deferred.)
- **Partial-failure tolerant**: a recoverable error in one thunk logs and returns `null` for that slot; the batch continues. A **non-recoverable** error halts the whole batch. → a proven partial-failure result model.
- **Phase-frozen scope** (`parallelPhaseOverride`): the current phase is pinned across the whole `parallel()` so one thunk's `phase()` call can't pollute siblings.
- **Worktree isolation is per-agent**, not per-batch: each `agent()` with worktree opt-in creates + tears down its own worktree in its `finally`. → **isolated parallel mutating tasks are already supported today, via the DSL.**
- **No concurrency cap inside `parallel()`** — it's unbounded `Promise.all`. Bounding lives up in the runner/worktree layer + `MAX_AGENT_*` config. → confirms [04]: any tool-level primitive must add an explicit cap; none exists at this layer to lift.
- **Result model**: positional array (Promise.all order preserved), `null` for failed slots.

### Implication for the shape decision ([03])

The repo **already** has a proven parallel path; the gap is **exposure, not implementation** — it's reachable only through the `workflow` JS DSL, never from the model-facing tool palette. This is strong evidence that the lightest high-value shape is one that **reuses** `parallel()`/`agent()` under the hood (lean toward option **(b) extend the existing tool** or **(c) a thin orchestration primitive**), not a from-scratch plural tool **(a)**. A mandatory explicit concurrency cap and a positional-array-with-null-failures result model are pre-decided by precedent — [04] refines the cap policy, [03] picks the surface.
