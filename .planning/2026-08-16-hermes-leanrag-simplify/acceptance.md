# Acceptance — hermes-leanrag-simplify (2026-08-16)

## LOC
27,173 → 27,199 (+0.1%). D2 (40-50% cut) UNMET — simplification landed as surface reduction + de-god-filing, not raw LOC: content cuts (06: −~500 near-dup/topic-key; 07: −601 kg-llm/commands) offset by the 08 composition split (+589) and shared-helper pilot (04, reverted as net-negative).

## Tool surface
10 → 6 (memory, search, knowledge_ingest, knowledge_search, skill_manage, skill_manage_help). Schema cost 3,066 → 2,033 tok (−34%). Hard pin ≤2,100 (SIX_TOOL_BASELINE recorded; re-pin consciously, never silently).

## Feature accounting
User-approved removals only: LLM kg extractor path, interview/insights commands, near-dup, topic-key. Kept 24.5/27 = 90.7% ≥ 80% target. (09 verdicts: memory-serializer family + triggerConsolidation verified LIVE and kept.)

## Architecture
index.ts 732→39 LOC thin barrel + composition/ 12 modules (LeanRAG build_graph shape). Contract-swap backends (BackendBundle factory). SurrealDB default + transparent sqlite fallback + /memory-switch-backend recovery. ADRs honored: hermes-0001 (①② deferral), monorepo-0001 (downward edges), pi-agent-0004 (two retrieval paths), 3-tier drift, freq-vote formula pinned.

## Deviations
D2 unmet (honest). D8 near-dup overturn executed. 04 extraction pilot net-negative → reverted, parallel dialects kept (LeanRAG Milvus/MySQL precedent).

## Gates
hermes: tsc clean, 1614 pass / 0 fail (137 files). tool-gate: 333 pass / 0 fail.
