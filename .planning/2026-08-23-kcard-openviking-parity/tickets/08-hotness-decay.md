# 08 — hotness decay port

type: grilling
blocked by: 07 (hotness feeds the ranking composition)

## Question

OpenViking's memory lifecycle: `hotness_score = sigmoid(log1p(active_count)) * exp(-λ·age)` with half-life 7 days, blended into ranking via `hotness_alpha` (~60 lines, trivially portable). kcard has the bounded-feedback rule already (context-lifecycle D8: re-ranks but never dominates, ≤±10%, and any scoring change must beat the count baseline on the eval set before defaulting).

Questions:

- Usage feed: RecallLedger (context-lifecycle, ticket 08's auto-recall injector writes it) as the `active_count` source? Plus explicit `zk_card` reads?
- Half-life: 7d default (OpenViking) or tuned to this vault's usage cadence?
- Half-life decay on what timestamp — last use, last retrieval, or card mtime?
- Does the eval-gate requirement (beat count baseline) apply before hotness ships on-by-default? (D8 says yes — wire that into ticket 09's gate, don't relitigate.)
