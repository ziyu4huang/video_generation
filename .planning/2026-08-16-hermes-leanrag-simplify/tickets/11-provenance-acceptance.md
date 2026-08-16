---
ticket: 11
status: done
blocked-by: [10]
---

## Goal

Refresh LEANRAG-PROVENANCE.md and complete the acceptance accounting.

## Scope

- Fix the stale status column (③⑥ shipped).
- Verify kept-features/total ≥ 80% against the 01 baseline.
- Final LOC count vs the 27,173 starting point.
- update src/constants.ts tool-name prose (memory_search/session_search → search) + prompt-context.test.ts assertions (deferred from ticket 02).

## Acceptance

- `acceptance.md` in the effort dir with the full accounting.
- Provenance doc accurate.

## Resolution

Acceptance recorded: 90.7% features kept, −34% schema cost, LOC flat (+0.1%, D2 unmet — surface simplification instead), provenance refreshed, effort complete.
