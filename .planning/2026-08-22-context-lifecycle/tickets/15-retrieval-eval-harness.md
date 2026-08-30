# 15 — one-command retrieval eval harness (+ BGE-M3 vs nomic A/B)

- **Phase:** P4 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-30

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

## Resolution (2026-08-30)

SHIPPED on `feat/kcard-t15-eval-harness`:

- `scripts/retrieval-eval.mjs` (kcard scripts/, allowlisted in scripts-dir-contract) —
  corpora `--corpus fixture|controlled|real` (fixture = inline offline set with forced
  mock embedder; controlled = papers-docagent + distill staged into one clean folder,
  battery derived from H1 titles; real = the committed 50-query English eval set),
  dims `--model bge-m3|nomic` (cache-keyed `.knowledge-semantic/<model>.json`),
  `--blend semantic|lexical`, `--tier`, `--hotness on|off`, `--k`; JSON receipts under
  `output/retrieval-eval/`.
- `src/eval/metrics.ts` — pure metric math (hit@k / MRR / tokens-per-render,
  target-absent exclusion, cards-returned token denominator); CI-pinned by
  `__tests__/retrieval-eval.test.ts` (hand-computed fixtures + offline fixture-mode
  spawn, 8 tests).
- `test:eval` npm script = `--corpus fixture` (offline, mock embedder) — opt-in, NOT in
  `test` or local_ci (D10, ≤5-min rule).

A/B receipts (2026-08-30, real corpus 2351 cards, k=4, tier=abstract, live LM Studio):

- bge-m3 semantic: hit@4 **47/50**, MRR **0.900**, 300.6 tok/query, 75.2 tok/card
- nomic semantic: hit@4 46/50, MRR 0.823, 306.2 tok/query, 74.3 tok/card
- bge-m3 lexical (reference): 34/50, MRR 0.582
- bge-m3 semantic + hotness ON, unseeded: byte-identical to baseline
  (`hotnessLedgerUsed=true`, production ledger empty → multiplier neutral) — t12's
  promotion trigger has NOT fired; this harness serves that re-eval when it does.
- controlled corpus (bge-m3): 23/23, MRR 1.000 — clean-field sanity row.

**Decision: D3 STAYS bge-m3 — now winning the English eval set too** (47 vs 46 hit@4,
MRR 0.900 vs 0.823 on the current corpus), reversing t07's then-observation (nomic 48 vs
47) that the battery result had to override. Fog entry settled. Baselines table recorded
in map ## Context.
