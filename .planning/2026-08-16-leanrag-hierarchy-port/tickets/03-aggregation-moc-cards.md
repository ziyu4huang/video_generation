# Ticket 03 — aggregation MOC cards (blocked-by: [02])

Goal: Aggregation nodes materialize as multi-level MOC cards.

Scope: extend ingest.ts writeMoc to multi-level (frontmatter: parent, entities union, sources contentHash-union, layer, clusterSize); derived-kind T2 semantics (regen-able, never supersede user cards); graph-health prunes orphaned nodes + regenerates MOC tree.

Acceptance: vault fixtures show 3-level tree; heal prunes orphans; md stays canonical (3-tier drift honored).
