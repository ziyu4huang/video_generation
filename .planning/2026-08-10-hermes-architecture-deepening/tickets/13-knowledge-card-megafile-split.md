---
type: feature
status: open
claimed:
blocked by: [12]
---
# 13 — knowledge-card megafile split (K1–K3)

Split the three megafiles (K1–K3) along the module seams surfaced by dedup ticket 12:

- **K1** `ingest.ts` 1767 LOC → adapters/ + render/ + engine
- **K2** `extensions/knowledge-card.ts` 1506 LOC → task builders to src/; tools split per-tool
- **K3** `retrieve.ts` 1102 LOC → extract graph-health module

## Precondition

Ticket 12 landed — splitting before dedup would duplicate the work (the dedup helpers define the seams the splits cut along).

## Acceptance (deletion-test gate)

- Module responsibilities single-line-declarable: each split module's purpose fits one sentence, no "and".
- No re-export shims left behind — imports point at the real new homes.

## Estimate
M

## Progress (2026-08-16, wave 1/3)
- ingest.ts 1699 → 512 LOC. New modules: types.ts 157 (shared data contract), card-render.ts 295 (pure markdown→card rendering), adapters.ts 628 (3 source adapters + input collection + jsonl), wiki-match.ts 72 (wiki dup-matching); slugify+normTag moved into card-format.ts — the pre-existing ingest↔card-format import CYCLE is GONE. VaultIndex re-export deleted (zero importers, deletion-test). Importers repointed: 6 in-package src + distill/converge + host-fns + source-watchlist (3 importers the survey missed, caught by typecheck) + extensions entry + 3 pi-agent CLI files + 10 test files (import lines only). Gates: typecheck clean; 432 tests / 0 fail. Remaining: wave 2 = K2 extensions/knowledge-card.ts 1506 split (task builders → src/); wave 3 = K3 retrieve.ts 1057 split (graph-health module).

## Progress (2026-08-16, wave 2/3)
- extensions/knowledge-card.ts 1492 → 1077 LOC. New modules: src/zk-task-config.ts 116 (tool allowlists, resolveDistillModel, blend scoring — exported so CLI reuses), src/task-builders.ts 325 (pure buildXxxTask template builders). Extension keeps compat re-export shims → 8 production importers + 14 test files untouched, ZERO test edits (better than wave 1's import-line repoints). One boundary clip caught+fixed (resolveKnowledgeVault closer at old-L263). Gates: typecheck clean; 432/0. Remaining: wave 3 = K3 retrieve.ts 1057 split (graph-health) + optional K2b tool-execute-body extraction (~758 LOC in factory) to reach <400 target.
