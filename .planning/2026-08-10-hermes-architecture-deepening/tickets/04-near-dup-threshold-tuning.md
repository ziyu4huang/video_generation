---
type: task
status: closed
---
# 04 — Near-dup threshold tuning (0.6 → 0.3–0.4)

Folded from archived effort `2026-08-07-how-is-current-memory-finding-duplicate-conflict` (its baseline: 0.6 → ~0.3–0.4 lifts near-dup recall 54.5% → ~95%, no precision loss).

## Acceptance
- `DEFAULT_NEAR_DUP_THRESHOLD` (src/store/near-dup.ts) tuned to the baseline-indicated band, config-overridable if not already.
- Regression coverage: near-dup recall fixtures at the new threshold; no precision regressions in the contract suite.
- Full hermes suite green.

## Closed (2026-08-16)

`DEFAULT_NEAR_DUP_THRESHOLD` 0.6 → 0.3 (src/store/near-dup.ts) — the study's best measured point: recall 0.545 → 0.955, F1 0.706 → 0.977, precision 1.000 unchanged. "Config-overridable" was already satisfied: the `PI_MEMORY_NEAR_DUP_THRESHOLD` env override pre-existed (memory-store.ts). New `__tests__/near-dup.test.ts` — recall-lift fixture (band [0.3, 0.6), null at the old 0.6), precision fixture (unrelated → null), MIN_TOKENS guard, exact-dup ~1.0. Full hermes suite green.
