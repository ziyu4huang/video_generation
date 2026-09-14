# plan.md — adjudication cover (arc-25 precedent)

The full wayfinder map lives in `map.md` (the planner self-committed it after
hitting its 40-turn cap — see `plan-receipt.json` `kind: "turns"` and the
map's Shipped-as disclosure). This stub is retained verbatim as the
adjudication cover: the planner's audit-fix commit renamed the canonical
artifact to map.md so the ledger guard's map-by-convention check passes.

Adjudicated decisions carried into the map unchanged: option (b)
subagent-scoped trust source; dispatch-cwd anchor; null→UNTRUSTED;
corrupt-store→ctx fail-open; batch anchors at defaultCwd (pre-existing
registry shape, charted).
