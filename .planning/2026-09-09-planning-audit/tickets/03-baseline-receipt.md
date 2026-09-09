# t03 — baseline receipt

Run the CLI on the untouched tree; commit `results/baseline/audit.{json,md}`
under this effort dir. Named checks: census total == actual dir count; every
red row enumerated; the executor-vs-planner count delta (72/12 vs 75/10)
recorded as a measured row (D8).

Acceptance: tables committed; baseline exit 1 is EXPECTED and recorded
(baseline is evidence, not a gate failure).
