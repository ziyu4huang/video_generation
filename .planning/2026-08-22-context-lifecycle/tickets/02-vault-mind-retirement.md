# 02 — vault-mind retirement (obsidian `semantic_search` removal)

- **Phase:** P0 · **Package:** `s2-agent-ext-obsidian` · **Status:** closed 2026-08-22 · **Breaking (D0/D2)**

## Problem

`obsidian semantic_search` proxies the external vault-mind service (FastAPI+ChromaDB,
all-MiniLM-L6-v2): CJK-weak on a Traditional-Chinese vault, `POST /api/collections/*/reindex`
stalls mid-rebuild, collection naming auto-prefix traps (memory index). D2 retires it; Tier-0
stays lexical+graph.

## Approach

1. Delete the `semantic_search` action: `extensions/obsidian.ts` action table,
   `src/lib/routing.ts` reference/help strings, the HTTP client, and
   `maybeTriggerReindex` + `VAULT_MIND_BASE_URL` / `VAULT_MIND_AUTO_REINDEX` envs in
   `src/lib/subagent.ts`.
2. Delete the `semanticSearch` / `semanticReindex` tests; update contract/baseline fixtures
   that enumerate actions.
3. `bun run --cwd bun-apps/s2-agent regen:manifest`; run the schema-cost measurement
   (`measure-schema-tokens.mjs` / perf regression test) and record the delta.
4. NO local fallback inside obsidian — semantic retrieval is `knowledge_query`'s job (D2;
   tier boundary preserved).

## Acceptance

- `semantic_search` absent from the tool schema and action help; `grep VAULT_MIND` in
  `bun-apps/s2-agent-ext-obsidian` returns nothing outside docs history.
- Obsidian full test suite green (`run-test.sh full`: `bun test extensions/__tests__/` +
  extension-contract standalone); schema-cost regression test updated with the new (lower)
  bound.
- Schema-cost delta number recorded in map Context.

## Verification

Canonical gates + frozen-baseline regen ONLY if the baseline text includes semantic output
(cite D0 in the commit). Deploy-order note: registry entry unchanged (same package/entry),
manifest regen only.

## Resolution (2026-08-22)

Removed, per Approach, with NO local fallback (D2): the `obsidian_semantic_search` tool
(the fat tool's `semantic_search` action dispatched into it via `_capturedTools`), the 4
dangling action-enum strings, `maybeTriggerReindex` + `VAULT_MIND_*` envs in
`src/lib/subagent.ts`, the `semanticSearch`/`semanticReindex` tests, and all README/PRD/
CONTEXT doc surface (README §Semantic replaced by a retirement note). Obsidian is fully
hermetic again (filesystem only).

**Scope expansion beyond the ticket text (justified by D0/D2, same commit):** zk-ask's
`three-way` / `semantic-lexical` blend modes seeded from `obsidian action:"semantic_search"`
— with the action gone their prompts would instruct a nonexistent call. Retired:
`BlendMode`/`BlendScoreParts`/`rankBlendScore`/`ragToolsFor`/`RAG_TOOLS_THREE_WAY`
(zk-task-config.ts), the blend branches of `buildRagTask`, zk_ask's `blend` param,
`zk-ask --blend` (s2-agent CLI), and `workflows/retrieval-quality-self-improve.js` +
its CLI test (the workflow existed to A/B those blend modes and needs vault-mind).
Precedent: the deleted param's own description recorded that the semantic blends never
won a regime (iter-6/iter-7 receipts); map Context's "graph dilution (three-way 67% <
lexical 80%)". `lexical-overlap-check.mjs` stays (hermes grill-decision consumes it).

**Measured schema-cost delta (2026-08-22, this machine):** agent total 22568 → **22235 tok
(−333)**: obsidian fat tool 156 → 148, zk_ask 762 → 437 (the huge `blend` param description).
kcard 4-tool total 2367 → **2019 tok** — `schema-cost.regression.test.ts` re-baselined
(≤2220 ceiling). Root `scripts/schema-cost-baseline.json` refreshed to the live measurement
(documented one-command refresh).

**Gates:** obsidian `run-test.sh full` ✓, kcard CI-matrix 3-phase (21+132+12) ✓ + tsc ✓,
s2-agent `bun test` 1040 pass ✓ + tsc ✓, `regen:manifest` ran (26 extensions, registry
unchanged).
