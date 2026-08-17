## Question
Beyond the pinned surfaces, what is untouchable in this simplification — on-disk card md shape, vault folder layout, store schemas, event contracts? Define the risk boundary + rollback discipline for the execution effort.
type: grilling
blocked by: 04

claimed: main-grilling (2026-08-17)

## Resolution
Untouchable: card md format & naming (incl. agg-L*-*), vault folder layout, surreal/sqlite schemas, event contracts, pinned surfaces (hermes 6-tool / ≤2100 schema tok; zk 4 tools), hierarchy no-tree golden tests.
Rollback discipline: each lever (L1 CLI retirement, L2 leaf hoist, L3 trivia, L4 docs) = one independent commit slice on a single feature branch, each revertible alone; squash-merge PR as usual.
