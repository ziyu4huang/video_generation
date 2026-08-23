---
status: done
blocking: []
---
# 02 — Hang-mode circuit-breaker in zk hierarchy build
Spec: D4-breaker. Anchors: zk hierarchy.ts:215 (`summary = await input.summarizeFn(joined, input.tokenBudget)` inside cluster loop :196 — results unchecked), hierarchy-build.ts:171 (depth loop breaks only on node-count/depth), zk-task-config.ts:119 (HIERARCHY_DEFAULTS const).
## Work
In the cluster loop: count consecutive empty/null summarizeFn results; on reaching K, stop requesting summaries for the remainder of the layer (skip-and-log, keep the layer's already-built nodes) and do not feed empty-summary nodes upward. K default 3, knob `summaryBreaker` in zk-task-config next to HIERARCHY_DEFAULTS (per-call overridable, same pattern as :165-167 fallbacks). Reset counter on a non-empty result.
## Acceptance
- Unit test: summarizeFn stub returning null always → build completes fast, no empty summaries propagated, breaker trips at K.
- Stub returning null×K then valid → counter resets, later summaries used.
- zk tests green.

## Resolution
Consecutive-empty summarizeFn circuit-breaker in the hierarchy.ts cluster loop:
after K consecutive empty/null results the layer stops calling `summarizeFn` and
degrades remaining over-budget clusters to deterministic truncation. Knob
`summaryBreaker` default 3 in `HIERARCHY_DEFAULTS` (zk-task-config.ts),
per-call overridable via the hierarchy-build fallback pattern
(`opts.summaryBreaker ?? HIERARCHY_DEFAULTS.summaryBreaker`). Empty-summary
nodes never propagate upward (degraded nodes carry `truncateSummary` text);
the streak counter resets on a non-empty result; `summaryBreakerTripped`
surfaces the trip on `BuildLayerResult`. zk 470/0 incl. 3 breaker tests
(`__tests__/hierarchy-breaker.test.ts`).
