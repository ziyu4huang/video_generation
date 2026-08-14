# Ticket 02 — commitScope by default
**status:** done  **risk:** low-med  **size:** small

## Goal
Auto-apply commitScope so `git add -A` sweeps are caught even when the
dispatcher omits it. (The #1155 sweep of 38 files was caught ONLY because the
dispatcher passed commitScope; most dispatches omit it.)

## Design sketch (DECIDE)
Option A — hard-require: if a subagent can commit (has write/edit/bash) and
commitScope is omitted, error at dispatch. Safe but heavy-handed.
Option B — warn-default: always run git-scope detection against the final diff
even without commitScope; emit a loud ⚠ on out-of-scope staging (never
auto-revert, consistent with git-scope.ts today).
Recommend B (matches existing detection-only philosophy).

## Acceptance
1. option chosen + rationale
2. detection runs by default; out-of-scope staging is flagged without
   commitScope being passed
3. tests green

## Files
subagent-tool.ts:182,910 ; git-scope.ts

## Shipped
Shipped via #1278
