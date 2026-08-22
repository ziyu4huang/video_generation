# 03 — hermes folds to a capture-only journal

- **Phase:** P0 · **Package:** `s2-agent-ext-hermes-memory` · **Status:** open · **Breaking (D0/D1) · RISKY (largest deletion)**

## Problem

Hermes recall is measured-dead (2026-08-19 audit: hit@1/3/5 0/20, MRR 0.000 — vectors DB
never created, lexical fallback returns zero rows for natural-language queries). The
semantic search surface costs 6-tool schema for zero recall, and re-arming it would
duplicate kcard's measured 1.00 blend. D1: fold to capture-only.

## Approach

1. **Pre-census (first step, before deleting):** enumerate every agent-facing tool, handler,
   test, and doc that touches the semantic search surface / vector path. Land the census in
   this ticket's resolution note.
2. Keep: session journal, auto-capture, correction detection, session_shutdown flush,
   `convergeHermesMemory` handoff to kcard (ADR-0001), deterministic exact-match session
   search.
3. Retire: semantic memory-search surface; dead vector path — `store/surreal/vector-store.ts`,
   `store/surreal/vector-store-helpers.ts`, `VECTOR_BOOTSTRAP_SQL`, `handlers/vector-backfill.ts`,
   related config/env surface.
   **Pre-decision (owner-approved 2026-08-22):** SurrealDB stays as the **store of record for
   the capture-only journal** (crud store; PR #753 Phase 3 backend, SurrealQL v3.2.3 traps
   already charted). It never enters the retrieval path — any vector surface in SurrealDB
   would re-arm the exact role D1/D2 just retired and duplicate kcard's measured 1.00 blend.
   Recall routes exclusively through kcard `retrieveRecords`. Future ledger upgrades
   (ticket 09 RecallLedger, ticket 11 usage ledger) start as lightweight derived files;
   SurrealDB is the natural upgrade position if volume ever demands it.
4. Rewrite the hermes ADR that planned the vector path (supersedes; cite D1 + the 0/20
   audit). Recall questions route through `knowledge_query`.
5. Update `bun-apps/s2-agent-ext-knowledge-card` docs that describe hermes recall
   (DEPENDENCIES.md / KNOWLEDGE-LAYER.md seam notes) — kept minimal per docs policy.

## Acceptance

- Hermes tool count reduced; every remaining tool deterministic-testable (no live-model
  dependency in tests).
- `run-test.sh` (hermes canonical gate) green; cross-package typecheck green
  (`s2-agent` cross-package typecheck gate — hermes standalone tsc is broken by design,
  see memory).
- ADR rewritten and `bun run test:adr` green.

## Verification

Canonical hermes gates + `bun run test:adr` + ticket 04's committed audit run as the
after-proof (hermes-journal questions answered via kcard retrieval).
