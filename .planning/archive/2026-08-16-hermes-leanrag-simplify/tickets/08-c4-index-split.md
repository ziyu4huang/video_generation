---
ticket: 08
status: done
blocked-by: [02, 03]
---

## Goal

Split `src/index.ts` (752 LOC) into thin composition modules (C4 index split).

## Scope

- Extract per-stage modules shaped like LeanRAG `build_graph`.
- No behavior change.

## Acceptance

- `index.ts` ≤ 100 LOC.
- Extension-contract test green.
- No import cycles (dep-guard).

## Resolution

index.ts 732→39 LOC thin barrel (C4 closed). composition/{stores,compose,handlers,store-providers,tools,project-skills,commands,knowledge-semantic} + events/{session-start,before-agent-start,message-end,session-shutdown}. Registration order preserved (session_shutdown last). Back-compat: getKnowledgePipeline + project-skills re-exports + default factory signature unchanged. Also fixed tool-gate collateral debt from ticket 03 (dead registrar/probe/gate refs → 333/0).
