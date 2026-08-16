---
effort: 2026-08-16-hermes-leanrag-simplify
status: complete
created: 2026-08-16
pipeline: wayfind→superpowers
---

# Map — hermes-leanrag-simplify

## Destination
pi-agent-ext-hermes-memory reshaped to LeanRAG architecture shape (~80%): ≤ ~15k src LOC (40-50% cut), 6 extension tools with hard schema-cost pin, SurrealDB default backend + sqlite fallback, 2 repositories, 2 dedup mechanisms, split composition root — with ≥80% of the feature checklist still working and all settled ADRs honored.

## Decisions
- D1 SurrealDB default, sqlite transparent fallback + embed backfill queue (user, grilling R2).
- D2 Cut depth LeanRAG-grade 40-50% LOC (user, grilling R1).
- D3 Tool surface 10→6 with hard cost pin (user, grilling R1).
- D4 LeanRAG ①② stay deferred — ADR-hermes-memory-0001 honored (user, grilling R1).
- D5 CUT: LLM kg extractor path + interview/insights commands; image-card pipeline and heat/worth scoring KEPT (user, grilling R2).
- D6 Acceptance = checklist×tests×cost pin, ≥80% kept by count (user, grilling R2).
- D7 3-tier drift + two retrieval paths honored, implementations simplified not removed (user, grilling R2).
- D8 Explicit overturn: near-dup 0.3 / signature / topic-key dedup mechanisms removed (supersedes hermes-arch 04, C6 #1349).
- D9 (04): repo extraction pilot net-negative (+364 LOC) — reverted; repos = parallel dialects (LeanRAG precedent); LOC cuts re-anchored to 06/07/09 content removal.

## Fog
- Seam compatibility audit (stale-seam, zk seam) during consolidation — verify before demoting planning_stale.
- origin/main moves fast (dea56780→fc18a154 during setup); ff before PR via devops chain.
- Effort complete 2026-08-16. D2 LOC target unmet (+0.1% — surface simplification instead). Follow-up: leanrag-hierarchy-port (seeded).

## Tickets
- 01 baseline → 02-03 tool-surface, 04 repos → 05 fallback, 06 dedup → 07 cuts, 08 C4, 09 dead-code → 10 cost-pin → 11 acceptance
