# 12 — hotness: bounded frequency×recency multiplier in retrieval

- **Phase:** P3 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open

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
