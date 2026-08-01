## Question

**What is the primitive?** — the shape decision, once scope ([02]) and landscape ([01]) are settled.

Three candidate shapes to weigh (informed by [01]):

- **(a) New plural tool** — e.g. a `subagents` (batch) tool taking an array of tasks, returning an array of results. Cleanest model-facing surface; most distinct from the existing tool.
- **(b) Relax + extend the existing tool** — drop the hard `executionMode: "sequential"` and add a concurrency/batch param so a turn's multiple `subagent` calls can run in parallel. Smallest diff; reuses one tool; but weakens the global serialization guarantee that other tools/assumptions may rely on.
- **(c) Lightweight orchestration primitive** — a small map/queue construct exposed to the model, short of the full `workflow` DSL. Middle ground.

The shape decision **includes the result model**: how do N results return to the model (ordered array, keyed map, streamed-as-ready)? And it interacts with the scope: read-only-first ([02]=A) leans toward (a)/(b) with no isolation; general parallel ([02]=B) leans toward (a) with worktree-per-child.

Resolve via `grilling` + `domain-modeling`; a rough **prototype** of the chosen tool's schema/result shape (a stub, not the build) may sharpen it before locking. **HITL** — the user picks the shape.

type: grilling
blocked by: 01 (landscape + precedent), 02 (safety scope)
claimed: wayfind-session 2026-08-01 (controller)

---

## Resolution

status: closed (grilled 2026-08-01)

**Decision: a new `subagents` batch tool** (option a), internally reusing `parallel()`/`agent()` + `MAX_CONCURRENCY`. Three sub-decisions:

**Shape — `subagents({ tasks: [...], concurrency })`.** A plural tool, distinct from the singular `subagent`. Rejected (b) *relax executionMode*: the `sequential` flag is a **deliberate contract** ("parallel fan-out goes through `workflow.parallel()`"; pi serializes any turn with a sequential tool), and pi-core's generic parallel-tool-exec has no batch semantics (no collective budget / partial-failure-as-null / positional result). Rejected (c) *orchestration primitive*: overlaps the `workflow` tool, risks a mini-DSL. The new tool keeps the singular `subagent` + its sequential contract **intact** (zero regression) and realizes [01]'s "exposure, not implementation" finding by wrapping the proven path. Schema cost is real → measured by the repo's schema-cost canary; keep it lean.

**Result model — positional array.** Results return in **input order**; each entry is the child's `{ output, status }` or **`null` for a failed slot** (matches `parallel()`'s `Promise.all` precedent). Each result echoes the task's **optional `id` + index** so the model correlates without counting. Rejected keyed-by-id (diverges from precedent, forces an id on every task).

**Read-only enforcement — enforced tool restriction.** Each child runs with the **tree-mutating tools excluded (`edit` / `write` / `bash`), non-overridable in the MVP** → guarantees no working-tree writes → truly safe parallelism in the shared (un-isolated) tree. A task needing writes belongs in the singular `subagent` (sequential) or `workflow`, not the batch. This is what makes [02]'s read-only scope an actual safety guarantee rather than a convention.

**Implications:**
- **[04] unblocked.** The batch tool carries a `concurrency` param; cap reuses `MAX_CONCURRENCY = 16` (workflow's proven bound). Per-batch collective budget + backpressure policy are [04]'s open questions.
- **Fog cleared — "Relationship to `workflow.parallel()`": RESOLVED → coexist.** The `subagents` tool wraps `parallel()`/`agent()` internally; the `workflow` DSL keeps general (incl. any future mutating) orchestration. Removed from Not-yet-specified.
- **Spec handoff shape**: `subagents` tool schema = `{ tasks: Task[], concurrency?: number }`, `Task = { task, id?, model?, tier?, tools?, excludeTools? }` with the edit/write/bash exclusion applied as a non-overridable floor. Positional `{ output, status, id?, index }[]` result.
