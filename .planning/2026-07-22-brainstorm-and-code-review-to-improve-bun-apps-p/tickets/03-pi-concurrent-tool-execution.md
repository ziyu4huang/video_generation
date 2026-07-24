---
type: research
status: closed
claimed: chart-session-2026-07-22
---

## Question

Does the pi engine execute multiple tool calls issued in one assistant turn concurrently or sequentially? This fact shapes whether parallel-from-parent is even possible and informs how the `subagent` tool should declare its own concurrency behaviour (given the scope decision routes parallel through the `workflow` tool).

## Resolution

Three findings, all from the pi SDK (`@earendil-works/pi-coding-agent@0.81.1`):

1. **Per-tool `executionMode` override.** `dist/core/extensions/types.d.ts`: each tool may declare `executionMode?: "sequential" | "parallel"` — `"sequential"` = must run one-at-a-time with other tool calls; `"parallel"` = may run concurrently. **If omitted, the default execution mode applies.**

2. **The default is parallel.** `examples/extensions/tic-tac-toe.ts` comment: *"default parallel tool-execution mode this races: `play` can resolve before …"*. So when the parent issues N tool calls in one assistant turn, they run **concurrently by default** unless a tool opts into `sequential`.

3. **There is a pi-native reference subagent extension** (`examples/extensions/subagent/index.ts`) that already implements Single / Parallel (`{tasks:[...]}`) / Chain (`{chain:[...]}`) modes by spawning a separate `pi` process per subagent, with `MAX_PARALLEL_TASKS = 8` and `MAX_CONCURRENCY = 4`, JSON-mode structured output, and a TUI result list.

**Implications:**
- The scope decision (parallel → `workflow` tool's `parallel()`, capped 16-live/1000-total, journaled) is well-founded: pi already has the concurrency primitive, and a capped/journaled path beats unbounded ad-hoc in-process fan-out.
- The workflow package's current `subagent` tool does **not** declare `executionMode`, so it inherits the **default-parallel** behaviour — meaning if a controller issues several `subagent` calls in one turn today, they already run concurrently but **uncapped** (each spawns a full in-process `WorkflowAgent` session). This is a latent, undocumented behaviour worth making explicit → ticket 10.
- Prior art for a parallel/chain subagent surface exists in-tree if the "route via workflow" decision is ever revisited.
