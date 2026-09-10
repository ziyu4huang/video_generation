---
effort: 2026-09-10-self-arc-21-receipt-validator
created: 2026-09-10
last: 2026-09-10
status: active
---

# Wayfinder map: 2026-09-10-self-arc-21-receipt-validator — INDEPENDENT RECEIPT VALIDATOR: stop trusting the harness's own grades

## Destination

qualify.ts's sweep verdicts are re-derivable from primary evidence: a devops-package
validator re-grades every scenario receipt by reading the RAW evidence (step-helper
entries, model lines, settle markers, receipt counts) without consulting the
harness's own pass/fail fields, and proves its teeth on a self-graded-pass-but-
actually-red fixture. The qualify-trust gap the deep exploration ranked #4 closes;
sweep summaries become claims the tooling can audit, not grades to take on faith.

## Context (measured at claim time, 2026-09-10)

- Charter queue head: `output/next-goal-20260910-065209.md` (Immediate steps 1–4,
  done-when boxes) — written and repointed via self-arc-19's own repoint tooling.
- The trust gap, precisely: `bun-apps/s2-agent-ext-subagent/scripts/qualify.ts`
  aggregates `summary.ts` from per-scenario receipts whose `pass` field is graded
  by the harness's own predicates (tui-drive + bench lineage); nothing re-reads
  primary evidence. The arc-17 fake-red incident (stale install + vendored-test
  sweep, proven by #2237's executor re-runs) is the same class one level up:
  grades without independent re-derivation.
- Receipt shapes to re-derive from: per-scenario receipt JSONs under
  `output/qualify<N>-full/<scenario>/` (step helper entries, model lines —
  glm-5.3-not-flash asserts, settle markers, timingsMs) and `summary.json` /
  `summary.md` counts. A specimen sweep with 10/10 green receipts is committed at
  `.planning/2026-09-10-self-arc-19/evidence/t06-sweep-summary.json` (summary
  only; full raw receipts stay scratch per convention — the validator runs on
  fresh sweeps or copied scratch dirs at test time).
- Planner/reviewer = zai/glm-5.3 double-pinned (arc-plan.ts / arc-review.ts).
  Review dispatch is UNHARVESTABLE (receipted absent — core spawnSubagent has no
  name field, no pi-runs record): the arc-review receipt IS the harvest.

## Tickets

<!-- planner fills: ranked tickets + Execution order line -->

## Decisions

- D1 (2026-09-10): arc number 21 claimed VIA `.planning/arc-ledger.json` at
  branch time (the self-arc-19 procedure's first consumer); verified free on
  origin/main's ledger before the append.

## Fog of war

- Exact receipt-JSON field shapes per scenario (tui-drive writes them; the
  planner/executor reads a real sweep's receipts before fixing the schema).
- Whether re-grading can be pure (receipt in → verdict out) or needs the live
  deployed agent (prefer pure; live re-run is a bigger arc).
- summary.json vs summary.md count drift (the 2026-09-10 sweep emitted both).

## Cross-effort links

- Builds-on: `2026-09-10-self-arc-19` (ledger + repoint tooling this arc uses;
  its evidence dir holds the sweep specimen; the deep-exploration report's
  fix #4 is this arc's charter).
- Absorbed-by: none.
