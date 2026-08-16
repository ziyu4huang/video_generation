# Ticket 05 — retrieval tree expansion (blocked-by: [03])

Goal: Auto tree-expansion in zk retrieveRecords.

Scope: after seed ranking, walk parentChain of top seeds; merge aggregation summaries as evidence (marked provenance); OFF-tree path byte-identical (pin with golden test); final ranking untouched (freq-vote authoritative).

Acceptance: golden tests — no-tree = byte-identical to today; tree = expanded evidence set, deterministic given fixtures; determinism tests adapted with seed fixtures.
