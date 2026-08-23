# Ticket 02 — headless workflows arming + budget directive (B2)

Status: open

## Problem

`bun-apps/s2-agent-ext-ultracode/src/workflow-editor.ts:502` — the input hook
that arms workflows mode (keyword `workflow`/`ultracode`) and parses budget
directives (`+500k`) returns early unless `event.source === "interactive"`.
Headless `-p` messages have a different source, so:

- workflows mode never arms headless (the model may still call `run_workflow`
  as an ordinary tool — measured live),
- a `+500k` directive in a headless message is silently ignored.

Measured 2026-08-23: message `ultracode +500k Run this workflow script …` via
`-p` produced run `mt5msv81-dq40xz` (34,019 tokens, completed) whose persisted
record at
`~/.pi/workflows/projects/video_generation__subagent-7b9ba1837451/runs/mt5msv81-dq40xz.json`
has NO `tokenBudget` / `tokenBudgetSource` field, and the model called
`run_workflow` as a tool rather than a forced-workflow turn.

## Decision needed (this ticket's first move)

Either (a) extend arming to headless sources — the cc-parity-2 spec §2
budget-directive row (ticket 05) documents the directive without an
interactive-only qualifier, so headless support matches the spec; or (b) keep
interactive-only and record the divergence in that §2 row + spec §9. Do not
code before choosing; update the spec row in the same PR as any code.

## Done when

- [ ] Option chosen and recorded (spec §2 row + this ticket).
- [ ] If (a): a headless `-p` message with `ultracode +500k` arms, the run
      record persists `tokenBudgetSource: "directive"`, and a test pins it.
- [ ] cc-parity-2 spec §2 budget-directive row updated in the same PR.

## Bounds

- Interactive-only behavior is guarded by existing ticket-05 tests — do not
  regress them.
