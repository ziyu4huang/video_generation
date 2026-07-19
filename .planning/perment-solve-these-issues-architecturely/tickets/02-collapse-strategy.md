# 02 — Collapse strategy: single id-namespace + single path

## Question

Given T01's finding that `convergeHermesMemory` (`hermes:<slug>`,
deterministic, wikiAware) is canonical-good but `writeTransferArchive`
(`pi-memory:<target>-<ts>-<Math.random()>`, non-deterministic) accumulates
duplicates — **how do we collapse to a single id-namespace and a single
convergence path** so the same lesson can never mint two cards?

### Candidates

- **(a) Kill the transfer-archive path.** Make `memory transfer` delegate to
  `convergeHermesMemory` (which already reads hermes `.md` directly) instead of
  minting its own `.knowledge.jsonl` with random ids. The `pi-memory:*`
  namespace ceases to be emitted.
- **(b) Keep the archive, fix the id.** `writeTransferArchive` mints
  `pi-memory:<target>:<contentHash>` (deterministic) so it upserts; both
  namespaces coexist but the wikiAware matcher (already on) collapses
  cross-namespace dupes.
- **(c) Unify on `hermes:<slug>` for ALL memory-sourced cards.** Delete the
  `pi-memory:*` namespace entirely; the distill pipeline's `runConverge`
  supersede step (mechanism B) becomes unnecessary and is removed.

### Decide

- Single canonical namespace = which? (`hermes:<slug>` is the existing canonical
  id; `pi-memory:*` has no content address today.)
- Does the distill pipeline's supersede (mechanism B) simplify or vanish once
  ids are deterministic?
- Is `writeTransferArchive`'s `.knowledge.jsonl` handoff still needed at all,
  or is it a vestige of pre-ADR-0001 routing?

type: grilling
claimed: wayfinder-session
blocked by: 01
status: closed

## Resolution (closed this session)

**Full unification + in-place upsert.**

**Decision 1 — approach: Full unification.** Single canonical namespace
`hermes:<slug>` for ALL entry lifecycles (live-in-DB AND evicted/transferred).
The hub's auto-converge (`convergeHermesMemory`) pulls BOTH the live hermes
`.md` dir AND the evicted/transferred archive dir — ADR-0001-compliant (hub
pulls hermes; hermes never calls up). The `pi-memory:<target>-<ts>-<rand>`
namespace is retired; the manual `zk_ingest --files <archive>` step is no
longer required (auto-converge covers it; `zk_ingest` stays as a tool for
explicit/generic ingestion). Chosen over minimal-id-fix (keeps the manual step
+ a second namespace) and kill-archive (loses fast-evicted entries — a fresh
invisible-failure, violates the destination).

**Decision 2 — distill mechanism B: VANISHES.** The enriched distill card
REUSES the raw card's `hermes:<slug>` id → `ingestRecords` upserts it in place.
`markSuperseded` (mechanism B) and `note.supersedesCardId` become dead code →
remove. Enriched content + provenance ride in the one card (`evidence[]`,
`sources[]`). Truest "one canonical card per lesson."

**Build includes (NOT separate tickets — implementation, not decisions):**
- `writeTransferArchive` + `writeKnowledgeArchive` mint `hermes:<slug>`
  (slug from entry text) instead of `pi-memory:<target>-<ts>-<rand>`.
- `convergeHermesMemory` ingests the archive dir alongside the live `.md` dir.
- `runConverge` / the distill `converge` action: enriched notes reuse the raw
  card's id; drop the `markSuperseded` step + `supersedesCardId`.
- The manual `zk_ingest --files <archive>` messaging in `formatTransferResult`
  is downgraded (no longer required; archive auto-converges).

**Note — the distill pipeline is NOT subsumed by auto-converge.** Auto-converge
is deterministic projection (raw `.md` → raw cards, no enrichment); the distill
pipeline (gate → enrich-in-context → converge) still produces CURATED cards.
They stay distinct; the distill pipeline just upserts instead of superseding.

**Unblocks:** T03 (completeness invariant — now one authoritative path to
measure coverage over) and T05 (legacy `pi-memory:*` migration — now a clear
single target namespace).
