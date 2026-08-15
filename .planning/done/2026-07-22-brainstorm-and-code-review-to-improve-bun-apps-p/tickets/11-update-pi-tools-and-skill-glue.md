---
type: task
status: closed
blocked by: [04-subagent-status-contract, 05-durable-progress-ledger, 06-file-handoff-helpers, 09-public-spawnsubagent-api, 10-subagent-executionmode-declaration]
claimed: chart-session-2026-07-22
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

## Resolution

**IMPLEMENTED.** `using-superpowers/references/pi-tools.md` consolidated all closed gaps (references/* glue only — skill bodies untouched, byte-identical invariant held; fidelity guard + bootstrap tests green, 115/0):

- **Tool-mapping table** — added a "Dispatch many subagents in parallel → `workflow` tool's `parallel()`" row.
- **## Subagents** (rewritten, comprehensive) — single-dispatch + `executionMode: "sequential"` (10, with the safe-for-fan-out note); **status contract** auto-parsed to `details.report`/`SddReport` (04); **persistence** to `~/.pi/subagents/runs/<id>.json` (08); **public API** `spawnSubagent` for peer-extension code (09).
- **## Parallel fan-out** (new section) — the ONE sanctioned concurrency path via the `workflow` tool's `parallel()`/`pipeline()`; `subagent` stays single/serial.
- **## SDD workspace & progress ledger** (05, already present) — extended with the **inline task-brief (verbatim fence-aware awk) + review-package (git diff) commands** to `.planning/<effort>/sdd/briefs|reviews/` (06), in 4-backtick fences (the awk contains a 3-backtick fence regex). "Don't call the script, do it directly" philosophy, consistent with rule 3.

The workflow side's programmatic-surface ubiquitous language (`spawnSubagent`, `SddReport`, `SubagentRunPersistence`, the `subagent` tool's executionMode) already lives in `pi-agent-ext-workflow/CONTEXT.md` (entries added as 04/08/09/10 landed). Verified: superpowers build clean, 115/0 (fidelity guard confirms the 14 SKILL.md unchanged + bootstrap rule-3 assertions intact).
