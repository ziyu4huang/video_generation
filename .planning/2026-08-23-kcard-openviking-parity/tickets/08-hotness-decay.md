# 08 — hotness decay port

type: grilling → resolved (2026-08-24, map D37–D39)
blocked by: 07 (hotness feeds the ranking composition)

## Question

OpenViking's memory lifecycle: `hotness_score = sigmoid(log1p(active_count)) * exp(-λ·age)` with half-life 7 days, blended into ranking via `hotness_alpha` (~60 lines, trivially portable). kcard has the bounded-feedback rule already (context-lifecycle D8: re-ranks but never dominates, ≤±10%, and any scoring change must beat the count baseline on the eval set before defaulting).

Questions:

- Usage feed: RecallLedger (context-lifecycle, ticket 08's auto-recall injector writes it) as the `active_count` source? Plus explicit `zk_card` reads?
- Half-life: 7d default (OpenViking) or tuned to this vault's usage cadence?
- Half-life decay on what timestamp — last use, last retrieval, or card mtime?
- Does the eval-gate requirement (beat count baseline) apply before hotness ships on-by-default? (D8 says yes — wire that into ticket 09's gate, don't relitigate.)

## Resolution (grilling answers → map D37–D39, user-confirmed 2026-08-24)

Upstream grounding (measured on the local clone): `openviking/retrieve/memory_lifecycle.py` — `freq = 1/(1+exp(−log1p(active_count)))`, `recency = exp(−ln2/half_life · age_days)`, missing `updated_at` → 0.0; `hierarchical_retriever.py` — `final = (1−alpha)·semantic + alpha·hotness`, and `retrieval_config.py` ships `hotness_alpha` default **0.0 (OFF)**.

- **Feed (D37)**: the `usage` append-only table (D12) is THE feed — auto-recall injector events AND explicit `zk_card` reads both land as usage rows (`kind` distinguishes); `active_count` = replayed count, decay ts = last use (max event ts); never-used → 0.0. mtime is not the clock.
- **Half-life (D38)**: 7d default (upstream), tunable constant; retune only on real ledger cadence data.
- **Bound (D39)**: α default 0 (OFF — matches upstream's own default AND D8); enabled α capped ≤ 0.10 = the ≤±10% bound; default flip only via the ticket 09 gate (D25/D27 precedent).
- **Eval gate**: applies (D8 cited, not re-decided) — the D14 A/B for this ticket runs hotness ON as a test arm vs the shipped default (OFF).

## Build scope

1. `src/hotness.ts` — pure `hotnessScore(activeCount, lastUsedAt, now?, halfLifeDays?)` + blend helper; unit-pinned edge cases (0 events, missing ts, α=0 passthrough, cap validation).
2. Usage writer: `recordUsage(stem, kind)` into `usage`; aggregate read (`active_count`, `last_used_at`) replayed from the table; wired into `zk_card` read path (explicit reads) — auto-recall injector lands with context-lifecycle's ticket 08, which consumes this surface.
3. Blend into both retrieval lanes (`retrieveRecords` flat + `hierarchical-retrieval.ts`) behind `hotnessAlpha` (default 0; ≤0.10 validated).
4. D14: A/B receipt (hotness ON arm vs OFF baseline) + independent reviewer subagent.
5. Fold-back candidate (Frontier): index rebuild automation if it fits the writer scope landed here.

## Resolution (build, 2026-08-24)

Shipped: `src/hotness.ts` (pure formula, D38 verbatim) + `src/usage.ts` (the D12 `usage` table's writer/reader — `recordUsage` append + `usageAggregates` GROUP BY replay) + pool-wide `(1−α)·score+α·hotness` blend on BOTH lanes (flat post-sort + semantic union + hier leaves pre-cut) + `fsStat` fire-and-forget usage recording (explicit card reads, D37) + harness A/B flags (`--hotness-alpha`, `--seed-usage targets|non-targets`, `--reset-usage`).

Key mechanics learned/pinned:
- **The blend must be POOL-WIDE** (never-used → h=0), not skip-no-event: skipping makes a used card's blended `(1−α)s+αh` lose to an equal-scored never-used card's untouched `s` — tie inversion, the opposite of the feature. Pinned in `__tests__/hotness.test.ts`.
- `zk_card find` is agent free-text (no structured card list) — the deterministic explicit-read seam is `zk_fs stat`; kind `zk_card` covers both (D37's "explicit zk_card reads" = the zk_* read surface).
- The semantic path composes: the flat blend runs first (order feeds lexRankNorm), then the union blend applies hotness again — bounded double-count (order-lift + ≤0.10 score-lift), recorded here rather than restructured; revisit only if a future gate arm shows distortion.

D14 A/B (receipts `output/recall-audit/receipt-ticket08-hotness-{baseline,on,noise}.json`, live bge-m3 + SurrealDB, 2026-08-24):
- **baseline** (α=0, empty ledger): 17/20 hit@5, hit@1 12/20, MRR 0.725 — byte-identical to the ticket-05 shipped numbers (default OFF is a true no-op).
- **noise control** (α=0.10, non-target usage seeded at equal event count): 17/20 / 12 / 0.725 — EXACTLY the baseline: usage noise does not move recall (the D8 ≤±10% bound holds; synthetic events cleared after the run, `--reset-usage`).
- **mechanism arm** (α=0.10, target usage): 18/20 hit@5, hit@1 18/20, MRR 0.900 — the bounded blend lifts recently-used cards as designed. CIRCULAR BY CONSTRUCTION (seeds = answer keys): a mechanism demonstration, NOT a production recall claim. Per D39 the default stays **0 = OFF**; any default flip routes through the ticket 09 gate with REAL ledger data once the injector feeds it.

Gates: kcard `bun run test` 589/589 (+17 hotness) + typecheck clean; hermes `scripts/recall-audit.test.ts` fixture green against the modified harness.

Not done here (recorded): **index rebuild automation fold-back stays open** — post-extract `rebuildCardIndex` trigger needs live-embedder cost care (shutdown lane), deferred to the effort close-out's spec rather than half-baked into 08. Tool-layer `hotnessAlpha` exposure also deferred to the gate-flip ticket (nothing may flip defaults outside ticket 09).
