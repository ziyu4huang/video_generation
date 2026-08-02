## Question

`qa/evaluate.ts` still consumes only the hardcoded `GATES` (FOLLOWUPS #2). Upgrade it to consume `buildEffectiveGates()` from owner-declared defs, then restore the 8 data-driven inspect precision/escape probes dropped in migration Task 3 (4 already recovered as unit tests). Restores the QA coverage lost during migration. Must land before the hardcoded GATES can be deleted (else evaluate.ts breaks).

type: task
blocked by:

## Note (from ticket 03)

A STOPGAP reconstruction (`reconstructOwnerDeclaredGates` in `qa/evaluate.ts`) was added in ticket 03 so the corpus stays live while tools migrate out of hardcoded GATES — it groups same-signature owner-declared tools into one multi-name gate. This is an APPROXIMATION (re-merged), not the literal effective gate set. Ticket 13 still must: (a) swap it for `buildEffectiveGates` so the corpus validates the literal effective (single-name) gates; (b) handle the coverage-model fallout (a migrated sibling becomes a standalone `names[0]` gate needing a probe or coverage-logic update — the stopgap's merge currently papers over this); (c) restore the 8 dropped inspect precision/escape probes (orthogonal; `probes.ts` has zero inspect entries today).
