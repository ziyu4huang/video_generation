## Question

**How is a parallel batch bounded and budgeted?** — the concurrency/backpressure model, once the shape ([03]) is chosen.

- **Concurrency cap**: fixed constant, config-driven (`~/.pi/...`), or a caller param on the dispatch? How does it interact with the existing `between-agent soft gate` (see `src/agent.ts`) and any global agent-count limits?
- **Budget model**: does a batch share **one collective budget** (sum of children), or does each child keep its own `tokenBudget`/`spendBudget` (already per-run via `checkBudgetExhaustion`)? When the collective budget trips, are in-flight children aborted (hard) or just no-new-children (soft, current between-agent behavior)?
- **Backpressure**: what does the parent see if the batch is throttled / a child hits `budget` status — partial results, a structured exhaustion report?

Scope note (see map's Out of scope): this ticket is the **batch-level** budget/concurrency question only. Session-wide aggregated budget across all of a controller's dispatches, and run **resume**, are deferred to a separate effort.

Resolve via `grilling` + `domain-modeling`. **HITL** — the user sets the bound policy.

type: grilling
blocked by: 03 (primitive shape — the budget model depends on it)
claimed: wayfind-session 2026-08-01 (controller)

---

## Resolution

status: closed (grilled 2026-08-01)

**Cap (finding — precedent-decided, not a real decision).** The `subagents` tool takes a `concurrency` param, **clamped to `[1, MAX_CONCURRENCY=16]`** (reusing workflow's `Math.min(MAX_CONCURRENCY, …)` at `workflow.ts:1307`), **defaulting to `defaultConcurrency`** (the existing configurable default, normalized `[1,16]` at `workflow-settings.ts:130`). Total children per batch stay under `MAX_AGENTS_PER_RUN=1000`. No new cap constant invented — the bounds already exist and are proven.

**Budget model (decision): per-child HARD + optional batch SOFT gate.**
- **Per-child**: each `Task` keeps its own `tokenBudget`/`spendBudget` (HARD — aborts that one child mid-run via the existing `checkBudgetExhaustion`/`BudgetExhaustion` machinery; per-turn check, may overshoot ~one turn).
- **Batch collective (optional)**: the `subagents` call accepts an optional collective `tokenBudget`/`spendBudget` that acts as a **SOFT gate** — checked **between dispatches**, **never aborting an in-flight child** (mirrors workflow's run-wide gate philosophy verbatim). When it trips, **no NEW children start**; running ones finish.
- Rejected *collective-HARD* (aborts in-flight → loses partial work, diverges from the 'never abort in-flight' philosophy both layers follow). Rejected *per-child-only* (can't bound the batch's TOTAL cost — the [01] cost-multiplier risk).

**Backpressure (follows from the result model).** The positional array preserves input order; each slot is `{ output, status, id?, index }` with `status ∈ done | failed | timedout`; slots **not dispatched due to the collective gate** return `{ status: "budget", exhaustion }` (distinct from `null`, which is a failed/errored slot). The batch result also carries a **top-level collective-exhaustion summary** when the gate tripped. The parent always gets structured partial results — never a silent truncation.

**Implication:** the spec is now **complete** (scope [02] + shape/result/enforcement [03] + cap/budget/backpressure [04], grounded by landscape [01]). The destination — a plan-ready spec for `writing-plans` — is reached. The one remaining Not-yet-specified patch (TUI grouping for N parallel runs) is build-time/downstream fog, not on the path to the spec; it graduates only after the tool is built.
