# 12 — hotness: bounded frequency×recency multiplier in retrieval

- **Phase:** P3 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-29

## Problem

Retrieval scoring ignores usage entirely — a card used daily ranks identical to one never
touched. OpenViking's hotness `sigmoid(log1p(active_count)) * exp(-ln2·age_days/half_life)`
(7-day) is a lightweight forgetting curve; D8 admits it only as a bounded re-rank signal.

## Approach

1. New `src/feedback/hotness.ts`: pure function, injected clock (`now` param — no
   `Date.now()` in the library), reads the usage ledger (lazy, memoized per call).
2. `retrieveRecords`: apply as a bounded multiplier `score * (0.9 + 0.2·hotness)` — feedback
   can re-rank ±10%, never dominate lexical/semantic evidence (the IDF-gate lesson applied).
3. Off-default option first (`hotness` in `RetrieveOptions`, default off) → promotion to
   default ONLY after the ticket-15 eval shows ≥ parity with the count baseline (the same
   gate IDF failed).
4. Donor reference: hermes `src/store/heat.ts` (its recency×worth composition informed the
   bounded-multiplier shape; hermes heat itself stays in hermes, unused post-fold).

## Acceptance

- Monotonicity tests: used-and-recent ranks up; stale usage decays to neutral (multiplier →
  1.0 as age → ∞); never-used cards unaffected.
- Bounded: multiplier ∈ [0.9, 1.1] by construction (property test).
- Eval re-run regression-free before any default promotion; decision recorded in map.

## Verification

Canonical kcard gates + eval receipt; if promoted, note the date+numbers in map Decisions.

## Resolution (2026-08-29)

- **Shape reconciliation (D13):** the prose's literal `score × (0.9 + 0.2·hotness)` sends
  never-used AND stale-decayed cards to ×0.9 — contradicting this ticket's own acceptance
  (stale decay → 1.0; never-used unaffected). Implemented `m(h) = 1 + HOTNESS_ALPHA_MAX·h`
  ∈ [1.0, 1.1] ⊆ the D8 [0.9, 1.1] envelope: reward-only, neutral at h=0.
- **Feed adapter:** `src/feedback/hotness-feed.ts` — `usedLedgerAggregates` replays the
  t11 jsonl into per-uri `{activeCount, lastUsedAtMs}` (mirrors `usageAggregates`' shape;
  `src/hotness.ts` consumes either ledger unchanged); pure, injected `now`.
- **Wiring:** `RetrieveOptions.hotness` (default OFF) + `usageLedgerPath` +
  `_hotnessNowMs` test hook; ledger read ONCE per retrieve call, threaded down all
  lanes; flat + semantic lanes apply pre-cut, hier lane post-cut (reorders within the
  served top-K only — recorded limitation). Trace: `options.hotnessLedger` +
  `hotnessLedgerUsed`. Distinct from t08's `hotnessAlpha` (SERVED ledger, additive);
  both on ⇒ compose multiplicatively.
- **Tests (`__tests__/hotness-feed.test.ts`, 14):** replay shape + torn-line tolerance;
  multiplier neutrality/monotonicity/`[0.9,1.1]` property test; 10-year decay → ~1.0;
  uri-then-stem lookup; default-OFF never reads the ledger; empty-ledger byte-identity
  (ranking AND scores); monotonicity (hot tie wins, 1-tag gap keeps rank 1, score ==
  base×m exactly); 90d decay < 0.01% score movement (asymptotic, tie-flip bounded);
  `usageLedgerPath` override round-trip; semantic lane single-application (F1
  precedent) + the 12/11 rank-gap-holds D8 pin.
- **D8 eval receipt (2026-08-29, real vault, live bge-m3,
  `output/recall-audit/t12-{baseline,used-targets,used-nontargets}.json`):**
  baseline 11/20 hit@1 · 16/20 hit@3 · 17/20 hit@5 · MRR 0.688 (reproduces t04
  exactly); seeded-targets ON 15/17/17 · 0.792; non-targets noise control
  byte-identical to baseline. Mechanism PROVEN (used-and-recent ranks up, noise moves
  nothing) — but the targets arm is circular by construction and the production
  ledger is still EMPTY (t11 shipped 2026-08-28, no live rows on this machine), so
  **the multiplier is NOT promoted: default stays OFF** (D13). Re-eval trigger: a
  populated real-usage ledger → unseeded on/off battery.
- **Harness:** `bun-apps/scripts/recall-audit.mjs` gains `--used-ledger on|off`,
  `--seed-used-ledger targets|non-targets`, `--reset-used-ledger` (receipt records
  `kcard.usedLedger`); kcard 764 pass / 0 fail, tsc clean, portability audit
  `--strict` green, recall-audit fixture test green.
