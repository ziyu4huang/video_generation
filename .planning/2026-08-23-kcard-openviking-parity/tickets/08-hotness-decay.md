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
