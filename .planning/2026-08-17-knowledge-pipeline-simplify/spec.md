# Spec — knowledge-pipeline integration polish

Synthesized from wayfind map 2026-08-17-knowledge-pipeline-simplify (censuses 01–03 + grilling 04–06). Destination reached: every lever decided, structure acceptance verifiable, risk boundary drawn.

## Goal
One low-risk polish effort over the four knowledge-pipeline packages (obsidian, hermes-memory, knowledge-card, core-interface): docs truth, CLI-tier retirement, leaf hoist dedup, trivia removal. ZERO behavior change; structural clarity is the criterion (LOC incidental).

## Levers (decided)
- L1 CLI retirement: remove zk src/loop.ts (350) + src/merge.ts (337) + their CLI commands (loop: 1 command + 1 test; merge: 3 CLI callsites retiring together) + their tests. −704 LOC, −2 modules.
- L2 Leaf hoist: move the embedder/cosine leaf (Embedder type + LM Studio /v1/embeddings fetch + cosine, ~60–100 LOC) and the fence-split leaf (~50 LOC) into @repo/pi-agent-core-interface; delete hermes-side mirrors (store/surreal/embedder.ts 101; card-vectors-cache.ts:59 cosineSimilarity; frontmatter-codec fence-split portion) — hermes re-imports from core-interface (legal edge; hermes→zk still seam-only).
- L3 Trivia: remove constants.ts INTERVIEW_PROMPT (~17 LOC, zero refs).
- L4 Docs truth: rewrite bun-apps/KNOWLEDGE-LAYER.md + per-package docs fixing ALL drift from ticket 01 (surreal default ×2, dead peerDep/vault-converge story, hermes tool-list omissions + search registration name, subprocess transport, sqlite framing, ARCHITECTURE module map/LOC, CONTEXT zk_extract, emit.ts absence) + runSubagentWithRetry ghost (ticket 03 row 5) + hierarchy reality.

## Structure acceptance (ticket 05)
1. Net file count ≥ −3 (excluding tests). 2. Dead exports zero (re-run census 02 method). 3. Drift census 01 re-run → zero high/med. 4. Mirrors-must-hoist rule recorded in zk CONTEXT + hermes docs.

## Risk boundary (ticket 06)
Untouchable: card md format/naming, vault layout, store schemas, event contracts, pinned tool surfaces, hierarchy goldens. Rollback: L1–L4 as independent commit slices, single branch, squash PR.

## Guards (all green at acceptance)
hermes suite (1620/0 baseline; mirror-file behavior tests move, not vanish) · zk suite (473/0 baseline minus retired loop/merge tests) · core-interface (26/0 + new leaf tests) · test:adr · dep-guard (hermes→zk seam-only; L2 adds hermes→core-interface only) · schema-cost pin unchanged.

## Out of scope
Package merging/re-tiering · LOC targets · tool-surface changes · fat-file splits · behavior changes · new dependencies.

## Handoff
to-tickets in a fresh effort dir (suggest 2026-08-17-knowledge-pipeline-polish): 5 tickets = L1, L2, L3, L4, acceptance+close.
