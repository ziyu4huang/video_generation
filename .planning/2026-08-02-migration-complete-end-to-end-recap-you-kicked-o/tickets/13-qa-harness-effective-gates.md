## Question

`qa/evaluate.ts` still consumes only the hardcoded `GATES` (FOLLOWUPS #2). Upgrade it to consume `buildEffectiveGates()` from owner-declared defs, then restore the 8 data-driven inspect precision/escape probes dropped in migration Task 3 (4 already recovered as unit tests). Restores the QA coverage lost during migration. Must land before the hardcoded GATES can be deleted (else evaluate.ts breaks).

type: task
blocked by:
