---
type: grilling
blocked by: []
status: open
---

# 05 — distill readState raw JSON.parse robustness

## Question

`distill/state.ts:readState` does `JSON.parse(...)` with **no try/catch**. A
corrupt `.distill-state.json` would throw inside `runConverge` AFTER cards are
already written — leaving a partial / inconsistent converge. KNOWN-ISSUES notes
this is not a valid-input trigger, but wrapping it would make converge robust to
state-file corruption.

**Decision: fix / accept?**

- If **fix**: spec the recovery — on parse failure: log + reset to empty state
  (treat as first run)? or skip this converge run? The choice matters: reset =
  re-converge from scratch (safe, slower); skip = preserve already-written cards,
  retry next run.
- One PR (test: feed a corrupt state file, assert the chosen recovery + no thrown
  crash).

## Read first

- `distill/state.ts`: `readState`, `writeState`, the state schema, and how
  `runConverge` consumes the returned state.
- Whether a corrupt-state path is reachable in practice (concurrent writes?
  crash mid-write?).
