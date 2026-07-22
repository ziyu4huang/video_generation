---
type: task
status: open
blocked by: [04-subagent-status-contract, 05-durable-progress-ledger, 06-file-handoff-helpers, 09-public-spawnsubagent-api, 10-subagent-executionmode-declaration]
---

## Question

Update the pi-port glue (`pi-tools.md` + any `references/*`) to reflect the closed gaps — the final documentation pass. Not a decision; the work the decisions unblock.

Current glue (`using-superpowers/references/pi-tools.md`) says the `subagent` tool *"covers SDD's implementer/reviewer dispatch; it does NOT provide chains/parallel/async/clarify in v1."* After tickets 04–10 land, that is stale. Update it to state:

- **Parallel:** fan-out goes through the `workflow` tool's `parallel()`; `subagent` is single-dispatch with explicit `executionMode` (per ticket 10).
- **Status contract:** how to read `DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED` (per ticket 04).
- **Durable ledger:** where progress lives + the read-at-start/append-on-clean contract (per ticket 05).
- **File handoffs:** the Pi paths for `task-brief`/`review-package`/`sdd-workspace` (per ticket 06).
- **Public API:** peer extensions call `spawnSubagent()` from code (per ticket 09).

**Invariant (do not violate):** only `pi-tools.md` + `references/*` may change — never superpowers skill **bodies** (byte-identical to upstream except this glue; PR #684). No new convention injections into skill bodies.

## First takeable step

After the blocking tickets close, draft the revised `pi-tools.md` section, diff it against the byte-identical baseline to confirm only glue changed, and run the superpowers fidelity guard test.
