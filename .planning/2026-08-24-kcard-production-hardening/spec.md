# Spec — kcard production hardening

Effort: `2026-08-24-kcard-production-hardening`
Supersedes the build plan hand-off of `2026-08-23-kcard-openviking-parity` (ticket 10 collapse; that effort's Core-5 is fully landed — see its map.md D1–D41).

## Problem Statement

The kcard Core-5 capability set (typed memory model, FS read surface, session extraction loop, hierarchical retrieval, hotness decay) is landed and default-on, but three production seams are unproven or degrading under real data:

1. **The extraction loop has never succeeded on the real journal.** Every recorded run against the ~101-entry hermes journal has `llmFailed: true` — first from the `:effort` model-id leak (fixed in PR #1976), then from the single-LLM-call shape (D28) simply not fitting a ~100-entry batch inside the shutdown budget. The 2026-08-24 backoff (PR #1976) stopped the 25s-per-session bleed, but the backlog is still unextracted and the loop has no demonstrated success path at real batch scale.
2. **In-place edits leave the SurrealDB index stale.** The D36 freshness gate keys on md-count + embed-model only; editing a card's content in place changes neither, so retrieval serves the flat md path (correct content, slower) until some count-changing event triggers a rebuild. The D41 rebuild automation narrows but does not eliminate this.
3. **Hotness is shipped but permanently OFF.** D39 keeps α=0 until a ticket-09-style gate on REAL ledger cadence data beats the count baseline (D8). The ledger now has two writers (zk_card reads via D12, retrieve echoes via D41) but no measured cadence and no gate run.

## Solution

Make the extraction loop demonstrably succeed at real scale (drain the backlog, keep fresh-only runs inside budget), make the index detect in-place edits (content-aware freshness fingerprint), and run the hotness α-flip gate once the ledger holds real cadence data — flipping α on only if it beats the count baseline. Alongside, assess the approaching SurrealDB scale trigger (knowledge-pipeline D03: 1925 cards already vs the ~2k threshold) and decide the relation-index strategy before it fires.

## User Stories

1. As an agent user, I want every session's journal entries eventually extracted into knowledge cards, so that session learnings accumulate instead of sitting in an unprocessed backlog.
2. As an agent user, I want a one-shot `-p` run to stay fast regardless of extraction health, so that the backoff never has to choose between data and latency (already true post-#1976; this effort keeps it true while the loop actually runs).
3. As an agent user, I want an in-place edit of a vault card to be reflected in indexed retrieval after the next rebuild trigger, so that hierarchical results never serve stale card content beyond one bounded window.
4. As an agent user, I want hotness to promote cards I actually use, so that retrieval reflects my real working set — but only once measured evidence shows it beats the count baseline.
5. As the vault owner, I want to know before it hurts whether the card/relation counts cross the SurrealDB scale threshold, so that the relation-index decision is made deliberately, not mid-incident.
6. As the operator of the hermes dual-backend stack, I want the sqlite fallback kept fresh by the existing two-way transfer cadence, so that a SurrealDB outage degrades capacity, not data.

## Implementation Decisions

- **Extraction success at scale is a batch-shape problem, not a model-choice problem.** The D28 single-LLM-call shape is kept as the per-batch contract; the loop gains bounded input chunking (a measured per-call entry cap, cursor advancing per successfully-processed chunk) so one huge journal cannot exceed any single call's budget. Model resolution stays central (capabilities.vision via `resolveKgModel`, `:effort` stripped — #1976 regression-pinned).
- **The PR #1976 backoff stays the shutdown safety net** — chunking must never re-open the possibility of unbounded shutdown spend. Shutdown runs may process at most the chunk budget's worth of work; the backlog drains via on-demand `zk_ingest` extract (never backoff-gated).
- **Freshness fingerprint becomes content-aware**: the D36 gate's md-count check is extended with a cheap aggregate over card files (e.g. size+mtime digest per file, or a rolling content hash) so an in-place edit changes the fingerprint. The gate still falls back to flat on mismatch — the fix makes the mismatch DETECTABLE, the fallback path stays the safety net.
- **Hotness α-flip follows the D25/D27 gate precedent**: standing three-arm recall-audit harness, real ledger cadence data (both D12 and D41 writers), α sweep bounded ≤ 0.10 (D39); default flips only on hit@5 AND MRR both beating the count baseline (D8 generalized). No flip → α stays 0 and the map records why.
- **Scale assessment before scale work**: measure card/relation counts against knowledge-pipeline D03 triggers; only then decide whether relation-index changes are a ticket here or a fold-back to knowledge-pipeline.
- Carried, cited, not re-decided: D2 (vault md canonical, Surreal rebuildable), D14 (every build ticket: A/B receipt + independent reviewer), D28–D31 (extract loop contracts), D36/D41 (freshness gate + rebuild automation), ticket 11's two-way db-transfer (sqlite fallback kept fresh by reverse sync — operational stance, no new build).

## Testing Decisions

- Extract chunking: deterministic unit suite with injected `_llm` (per-chunk cursor advance, partial-failure mid-batch, backoff interplay); live A/B on the real journal = the backlog-drain receipt (D14).
- Freshness fingerprint: unit tests over a fixture vault (edit-in-place flips the fingerprint; append/rename/delete still detected); the startup-cost A/B is a perf receipt (gate must stay cheap — it runs every session).
- Hotness gate: the existing `recall-audit.mjs` three-arm harness + ledger replay; gate-decision logic already CI-pinned by the ticket-09 fixture smoke.
- Scale assessment: measured counts + a written decision in the map; no code gate.

## Out of Scope

- Any OpenViking capability beyond Core-5 (VikingBot, Web Studio, multi-tenancy, cloud rerank/intent — kcard-parity D1 stands).
- The context-lifecycle auto-recall injector (downstream consumer; its ticket queue lives in that effort).
- hermes consolidation/startup performance beyond what #1976 shipped (the 114-rt N+1 and shutdown backoff are closed).
- A new migration tool — ticket 11's `db-transfer.ts` is the standing two-way reconciliation; at most a cadence note.

## Further Notes

- Evidence anchors for the problem statement: receipts `output/kcard-extract/run-*.json` (llmFailed:true, candidates:101, every run pre-#1976), PR #1976 E2E (36.6s → 5–6s one-shot; `skippedBackoff: true` receipts), kcard map D36/D39/D41, ticket 11's convergence tables.
- The `:off` model-id leak taught a standing lesson: every central model-spec consumer must strip pi's `model:effort` form before handing an id to a provider — grep for other `resolveModelRole` consumers when touching model config.
