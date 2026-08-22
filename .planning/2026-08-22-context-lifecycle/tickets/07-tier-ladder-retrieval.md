# 07 — tier ladder in retrieval (L0/L1/L2) + BGE-M3 re-baseline

- **Phase:** P1 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open · **Breaking contract change (D0/D5)**

## Problem

`retrieveRecords` returns full bodies regardless of need; downstream renderers (digest,
zk_ask context assembly, workflow host-fn) each truncate their own way. OpenViking's tier
ladder + demote-not-truncate replaces ad-hoc truncation. This ticket also carries the D3
eval gate.

## Approach

1. `src/retrieve.ts`: `RetrievedCard` gains `tier` (`"abstract"|"overview"|"full"`) +
   pre-rendered per-tier text: L0 = title + tags + `summary` (ticket 05); L1 = body lead
   (~600 chars) for leaves / agg `summary` for nodes; L2 = full body.
2. Renderers: `formatDigest`, `knowledge_query`, `zk.retrieve` host-fn, and `buildRagTask`'s
   2-tier context assembly move onto the ladder — L0 default, L1 on detail flag, L2 on
   explicit request; an entry that overflows its budget DEMOTES to a shallower tier instead
   of truncating (OpenViking rule, verbatim).
3. `zk-spawn-parity` / two-read-path drift-guard tests updated (contract change, cite D0).
4. **D3 eval gate:** re-run the existing eval set under BGE-M3 (ticket 01's canonical);
   hit@4 must be ≥ the nomic baseline (1.00 recorded). If it drops, D3 flips back to nomic
   (numbers + decision recorded in map), and the ladder work is unaffected.
5. Measure default-render tokens/card vs full body (target ↓ ≥ 40%); prune the stale nomic
   `.knowledge-semantic` cache if D3 held.

## Acceptance

- Retrieval/render tests green; demote-not-truncate unit tests; tokens/card measurement
  recorded.
- Eval receipt: BGE-M3 hit@4 vs nomic baseline, decision recorded in map Context.
- `bun test __tests__/` + extension tests green.

## Verification

Canonical kcard gates + the eval receipt + `kcard-coverage-measure.mjs` run (convergence
coverage must not regress).
