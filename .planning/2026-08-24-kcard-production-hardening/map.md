---
effort: 2026-08-24-kcard-production-hardening
created: 2026-08-24
last: 2026-08-24
status: active
---

# kcard production hardening — extraction success, freshness, hotness gate, scale

## Destination

The kcard Core-5 stack (landed by `2026-08-23-kcard-openviking-parity`) runs correctly under real data: the session-extraction loop demonstrably drains the real journal backlog inside bounded budgets, an in-place card edit is detected by the freshness fingerprint (index never stale beyond one rebuild window), the hotness α default is decided by a real-ledger gate run (flip only on a measured win), and the SurrealDB scale trigger is assessed before it fires. Spec: `spec.md` (to-spec collapse of the parity effort's ticket 10).

## Context

Measured 2026-08-24 on this machine unless noted.

- **Core-5 landed and default-on** (parity effort D1–D41): typed model (04), FS surface + D27 hier default (05), extraction loop (06, D28–D31), hierarchical retrieval (07/09), hotness (08, D37–D39 α=0 OFF), rebuild automation + retrieve echo (D41, PR #1974).
- **The extraction loop has never succeeded on the real journal**: every receipt pre-#1976 shows `llmFailed: true, candidates: 101` (first cause: `resolveKgModel` leaked the `:effort` suffix → LM Studio silently routed to bonsai-27b; second: the ~100-entry single call cannot fit the 25s shutdown budget). PR #1976 (merged 2026-08-24, E2E 36.6s → 5–6s one-shot) shipped the `consecutiveFailures` backoff — the bleed stopped, the backlog remains.
- **hermes startup N+1 closed same PR**: sync 103 HTTP round-trips → one `getCardsByKind` per batch; sync now under the 50-rt breach threshold.
- **Freshness gate (D36) is count-based**: md-count + embed-model only — an in-place edit changes neither, so the hier index serves via the flat md fallback until a count-changing event rebuilds (D41 automation narrows, does not eliminate).
- **Hotness ledger now has two writers** (D12 zk_card reads; D41 retrieve echoes) but no cadence measurement and no gate run; α stays 0 per D39 until it beats the count baseline (D8).
- **1925 active cards at parity-effort open** (real-vault receipts) vs knowledge-pipeline D03 scale triggers ≈2k cards / ≈5k relations — extraction lanes now writing make the crossing plausible this effort.
- Standing harnesses: `recall-audit.mjs` three-arm (D23), `hier-english-eval.mjs`, CI fixture smoke `__tests__/eval-gate.test.ts`; standing reconciliation `s2-agent-ext-hermes-memory/scripts/db-transfer.ts` (ticket 11, two-way, insert-only).

## Tickets

**Execution order:** 01 → 02 → 04 → 03 (user-confirmed 2026-08-24; 03 last — its ledger cadence data thickens with time, 04 is a quick measured read)

### Phase A — close the standing degradations

- [x] 01 — Extract backlog drain: chunked success path at real batch scale (complete 2026-08-24: seenIds 0→101, cf→0, final run 5/5 chunks clean; receipts `run-extract-20260824211225…212956`; chunking suite §7, 607 pass; reviewer APPROVE — PR pending)
- [x] 02 — Content-aware freshness fingerprint (in-place-edit staleness) (complete 2026-08-24: gate fingerprint leg live, 1ms/61-card receipt, 8-test suite, reviewer APPROVE inline — PR pending)

### Phase B — gates & assessment

- [ ] 04 — SurrealDB scale-trigger assessment (D03 nearing) (open)
- [ ] 03 — Hotness α-flip gate on real ledger data (open; may honestly defer if cadence is still thin)

## Decisions

- **D1 — Chunking, not model-swapping, is the extract success path.** The D28 single-LLM-call contract stays per-batch; bounded input chunks with per-chunk cursor advance make any batch size fit any budget. Reason: the measured failure is budget/shape (2048-token first attempt truncates on a reasoning model; ~100 entries exceed 25s), not model quality; and model choice is centralized policy (capabilities.vision, #1976 regression-pinned).
- **D2 — The #1976 backoff invariants are load-bearing and stay.** Shutdown runs may process at most one chunk budget's work; on-demand `zk_ingest extract` is never backoff-gated and is the backlog-drain lane. Reason: the 25s-per-session tax must never return while the loop gets healthier.
- **D3 — Freshness fingerprint goes content-aware at the gate, not at the index.** The fix makes an in-place edit DETECTABLE (size+mtime digest or rolling hash per file); the flat fallback stays the live-session safety net. Reason: D36's fallback already guarantees correctness — the gap is detection, not recovery.
- **D4 — Hotness gate deferral is an acceptable honest outcome.** If ledger cadence is too thin, the ticket records the measured reason and leaves the harness standing (D25/D27 precedent: no flip without both metrics beating baseline).
- **D5 — Scale assessment before scale work.** Measure D03 counts first; relation-index work only if the verdict is over, else a cross-effort fold-back link. Reason: ticket-03 BFS costs measured fine; premature index work is unmeasured scope.
- Carried (cited, not re-decided): parity D2 (md canonical), D8 (bounded feedback), D14 (A/B + reviewer per build ticket), D28–D31, D36, D39, D41; knowledge-pipeline D03.

## Frontier

**Ticket 04 (SurrealDB scale-trigger assessment)** — with 01 drained (+52 cards written) and 02's fingerprint gate live, the remaining pre-03 work is a measured read: card/relation counts vs the knowledge-pipeline D03 triggers (≈2k cards / ≈5k relations). Quick assessment ticket — no build unless the verdict is over.

## Fog of war

- Optimal chunk size / first-pass token budget for the extract LLM — measure on the real journal during 01 (gemma-4-12b reasoning overhead vs a `:off`-capable tier config).
- Whether the D41 retrieve echo's ledger volume is already meaningful for the 03 gate (echo landed 2026-08-24 — likely weeks thin; the deferral path D4 exists for exactly this).
- Ledger injector (context-lifecycle downstream) timeline — external dependency for 03's cadence thickness.
- ~~Whether `resolveModelRole` has OTHER consumers leaking `model:effort` into provider ids~~ RESOLVED during 01: only `resolveKgModel` (llm-chat.ts, feeds LM Studio) touches a provider id and it strips the suffix; zk-task-config's distill model feeds pi subagent spawn where `model:effort` is legal syntax.

## Cross-effort links

- `Builds-on: 2026-08-23-kcard-openviking-parity` — Core-5 + harnesses + D41 automation all landed there (ticket 10 collapse birthed this effort's spec); its D-numbers stay citable here.
- `Builds-on: 2026-08-22-context-lifecycle` — D3 embed canonical; its ticket-08 auto-recall injector feeds the 03 ledger (and is 03's external dependency).
- `Shares-decision-with: 2026-08-08-knowledge-pipeline` — D03 scale triggers adjudicated in ticket 04; D04/D05 SurrealDB stance instantiated for kcard by parity D2.
