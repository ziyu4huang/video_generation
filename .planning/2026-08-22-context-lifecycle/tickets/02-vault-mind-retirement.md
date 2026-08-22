# 02 — vault-mind retirement (obsidian `semantic_search` removal)

- **Phase:** P0 · **Package:** `s2-agent-ext-obsidian` · **Status:** open · **Breaking (D0/D2)**

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
