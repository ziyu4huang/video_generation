# Ticket 05 — retrieval tree expansion (blocked-by: [03])

Goal: Auto tree-expansion in zk retrieveRecords.

Scope: after seed ranking, walk parentChain of top seeds; merge aggregation summaries as evidence (marked provenance); OFF-tree path byte-identical (pin with golden test); final ranking untouched (freq-vote authoritative).

Acceptance: golden tests — no-tree = byte-identical to today; tree = expanded evidence set, deterministic given fixtures; determinism tests adapted with seed fixtures.

## Resolution
DONE. Auto tree-expansion when agg-L*-* MOCs exist: scan loop never ranks agg files; post-ranking expandWithTree appends ≤3 lineage-matched node summaries (layer-desc) as viaTree:true evidence cards; ranking authoritative (freq-vote/tag order untouched); digest + count ranked-only (non-invasive). No agg files → byte-identical (retrieve/blend goldens green + new golden test). 4 new tests; zk suite 469/0, typecheck clean.
