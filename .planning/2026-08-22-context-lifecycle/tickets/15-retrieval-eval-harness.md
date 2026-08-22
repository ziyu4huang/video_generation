# 15 — one-command retrieval eval harness (+ BGE-M3 vs nomic A/B)

- **Phase:** P4 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open

## Problem

Eval assets are scattered: the real-retrieval eval set (hit@4 bar), the controlled corpus
(scripts/controlled-corpus.mjs), coverage measure (kcard-coverage-measure.mjs), the ticket-07
re-baseline, ticket-12's promotion gate. D10: one committed, opt-in command — never in
local_ci.

## Approach

1. Consolidate `scripts/retrieval-eval.mjs`: corpus choice (real vault / controlled corpus /
   fixture), dimensions (blend mode, tier render, hotness on/off, embed model), metrics
   (hit@k, MRR, tokens-per-render); JSON receipt under `output/`.
2. Add `test:eval` npm script (opt-in; NOT part of `test` or local_ci gates).
3. Run the BGE-M3 vs nomic A/B on the real eval set (settles the D3 fog entry even if
  ticket 07 already gated the default) + record the hotness on/off comparison (ticket 12's
  promotion evidence).
4. Baselines table (model, mode, hit@4, MRR, tokens/render, date) recorded in map Context.

## Acceptance

- `bun run test:eval` works offline on fixtures (mock embedder) for CI-verify of the harness
  itself; live modes documented.
- Baselines table in map with measured dates; A/B decision note.

## Verification

Harness self-test in the package suite (fixture-only, fast, deterministic); local_ci
untouched (≤5 min rule).
