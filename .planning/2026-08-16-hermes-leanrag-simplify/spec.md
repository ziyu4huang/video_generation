# Spec — hermes-leanrag-simplify

## Problem
`pi-agent-ext-hermes-memory` has grown to 27,173 src LOC with structural redundancy: 4 repository implementations (~3,900 LOC), 5 dedup/identity mechanisms, 3 overlapping search tools, 3 serializer families, a 752-LOC composition root (`src/index.ts`, open item C4), and dead code (`Card.embed` typed-never-persisted, generic-deferred ingest family, unused serializers). 10 extension tools are registered but the schema-cost regression only pins 5. The architecture has drifted away from the LeanRAG-shaped simplicity it was seeded from.

## Solution
Reshape hermes-memory to ~80% LeanRAG *architecture shape* (not a literal copy — LeanRAG ①② stay deferred per ADR-hermes-memory-0001): small orchestrator, backend swap by output contract, SurrealDB as DEFAULT backend with transparent sqlite fallback, one unified search tool, and a hard schema-cost pin on the entire surviving tool surface. Target: 40-50% src LOC reduction while keeping ≥80% of the 25-item feature checklist working (kept-features/all-features by count).

## User Stories
- As an agent session, I get memory/knowledge tools with ~40% smaller schema cost and identical core capability.
- As the operator, SurrealDB runs as my default memory backend; if it is down, memory tools still work via sqlite fallback and embeddings backfill when it returns.
- As a maintainer, there are exactly 2 repository implementations behind one contract and 2 dedup mechanisms, so changes land in one place.

## Implementation Decisions
1. **SurrealDB default backend** (`config.dbBackend` default `surreal`); on unreachable Surreal: transparent fallback to sqlite (CRUD+FTS, no embeddings), queue embed backfill for replay when Surreal returns. Honors "Surreal=embed-only, sqlite=CRUD+FTS" (kp map 04).
2. **Repository consolidation 4→2**: one `MemoryRepository` + one `SessionRepository` contract, sqlite + surreal as the two impls. Drop the 2 redundant repo variants.
3. **Dedup 5→2**: keep exact-match (repo contract) + contentHash. EXPLICITLY OVERTURN near-dup threshold 0.3 (hermes-arch 04/C6 #1349), signature, and topic-key mechanisms — recorded here as the overturning decision.
4. **Search tools 3→1**: `memory_search` + `session_search` merge into one search tool with a `mode` param (memory|session); knowledge_search stays separate (zk graph retrieve is a different contract, ADR-pi-agent-0004 two-path decision honored).
5. **Tool surface 10→6**: keep `memory`, `search` (unified), `knowledge_ingest`, `knowledge_search`, `skill_manage`, `skill_manage_help`. Demote: `memory_supersede` (folds into `memory` as an action), `grill_decision` + `planning_stale` (internal handlers; MUST keep publishing the `__piHermesStaleCheck` seam so wayfind graduation keeps working).
6. **Schema-cost hard pin**: re-measure and pin ALL 6 surviving tools (existing 5-tool baseline 1550 tok / ≤1700 budget stays; add all-tool budget ~≤2100 tok).
7. **CUT (user-approved)**: LLM kg extractor path (`kg.llm` opt-in removed — dictionary extractor only, byte-identical to today's default); interview/insights/switch interactive command handlers.
8. **C4**: split `src/index.ts` (752 LOC) into small orchestrator modules (LeanRAG build_graph.py shape: thin composition, per-stage modules).
9. **Dead code removal**: `Card.embed` never-persisted field, generic-deferred ingest family, unused serializer family.
10. **LEANRAG-PROVENANCE.md refresh**: fix stale status column (③⑥ shipped, not Porting/Deferred).
11. **HONOR (do not touch)**: 3-tier drift (T1/T2/T3), two zk retrieval paths, ADR-monorepo-0001 downward dep edges, Hermes-spine layering, frequency-vote formula `(signalCount-1)*boostWeight + bestRankScore` (bw=1.0, vote before dedup+cap).

## Testing Decisions
- Acceptance = feature checklist × tests × cost pin: every KEPT feature from the 25-item inventory has green (possibly adapted) tests; kept-features/all-features ≥ 80% by count.
- Repository-contract suites must pass for both surviving repos; knowledge-spine e2e suites (corpus-roundtrip, pipeline-e2e, search-tool, seam) stay green.
- New schema-cost regression pins all 6 tools; `bun test` for the package green; `check:schema` clean.
- Existing stash@{0} WIP (oneshot-smoke, unrelated) is NOT part of this effort.

## Out of Scope
- LeanRAG ① semantic-aggregation hierarchy + ② LCA tree retrieval (ADR-hermes-memory-0001 stays).
- zk (pi-agent-ext-knowledge-card) internals beyond seam compatibility.
- GUI, python pipeline, wayfind internals.
- Restoring the stashed oneshot-smoke WIP (separate effort on feat/subagent-dispatch-hardening).
