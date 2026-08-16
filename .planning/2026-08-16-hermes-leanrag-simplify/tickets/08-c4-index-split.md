---
ticket: 08
status: open
blocked-by: [02, 03]
---

## Goal

Split `src/index.ts` (752 LOC) into thin composition modules (C4 index split).

## Scope

- Extract per-stage modules shaped like LeanRAG `build_graph`.
- No behavior change.

## Acceptance

- `index.ts` ≤ 100 LOC.
- Extension-contract test green.
- No import cycles (dep-guard).
