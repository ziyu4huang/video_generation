---
type: grilling
blocked by: []
status: open
---

# 04 — partial zk_ingest re-ingest produces asymmetric 相關 edges

## Question

Re-ingesting a SUBSET of sources recomputes outgoing `相關：[[...]]` edges only for
the re-ingested cards; untouched existing cards keep their prior outgoing links.
So a newly-related card can reach an existing one, but NOT vice-versa, until that
existing card is itself re-ingested. KNOWN-ISSUES flags this as inherent to
incremental upsert; a full re-ingest of all sources rebuilds symmetrically.

**Decision: fix / mitigate / accept-as-wontfix?**

- The crux is feasibility of **cheap inbound recompute**: when card X is
  (re)ingested and now relates to existing card Y, can we cheaply add the X→Y
  edge to Y's outgoing set too, or does that require re-scanning Y's content?
- Mitigation candidates: a `--recompute-all-edges` flag; document the asymmetry +
  recommend full re-ingest for link-integrity; or a post-ingest "edge sync" pass.
- If **accept**: rationale.

## Read first

- `pi-agent-ext-knowledge-card/src/ingest.ts`: the edge-recompute path (how
  `相關` edges are derived + written per card).
- Whether edge derivation is content-based (recomputable from Y's content alone)
  or pair-based (needs both X and Y).
