# Ticket 04 — retry-loop / runaway detector
**status:** done  **risk:** med  **size:** medium

## Goal
Circuit-break repeated identical-failure retries and no-progress turns. (6x
"durable memory" retries in the history; runaway token waste.)

## Design sketch
- Track consecutive identical-error retries in the dispatch layer; abort at
  N=2–3 consecutive identical failures (retryOnTransient already retries once
  on transient — this catches the SEMANTIC repeat).
- May overlap retryOnTransient — clarify scope.

## Acceptance
1. detector aborts after N identical failures
2. test green

## Files
subagent-tool.ts / spawn-subagent.ts

## Shipped
Shipped via #1279
