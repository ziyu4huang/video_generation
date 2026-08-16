---
type: task
status: open
---
# 04 — Near-dup threshold tuning (0.6 → 0.3–0.4)

Folded from archived effort `2026-08-07-how-is-current-memory-finding-duplicate-conflict` (its baseline: 0.6 → ~0.3–0.4 lifts near-dup recall 54.5% → ~95%, no precision loss).

## Acceptance
- `DEFAULT_NEAR_DUP_THRESHOLD` (src/store/near-dup.ts) tuned to the baseline-indicated band, config-overridable if not already.
- Regression coverage: near-dup recall fixtures at the new threshold; no precision regressions in the contract suite.
- Full hermes suite green.
