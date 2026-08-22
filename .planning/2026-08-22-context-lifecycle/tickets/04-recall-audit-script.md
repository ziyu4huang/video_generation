# 04 — committed recall-audit harness + post-fold baseline

- **Phase:** P0 · **Package:** `s2-agent-ext-hermes-memory` (script) · **Status:** open

## Problem

The 2026-08-19 audit ran from `/tmp/hermes-audit/run-audit.ts` — uncommitted, unreproducible,
and its one fix (SurrealQL projection) lives only in /tmp. D10: eval harnesses are committed
scripts.

## Approach

1. Port the runner to `bun-apps/s2-agent-ext-hermes-memory/scripts/recall-audit.mjs`
   (bun-run; parameterized corpus path + k against: (a) the hermes journal via the folded
   exact-match search, (b) the SAME questions via kcard `retrieveRecords` /
   `knowledge_query` over the converged vault).
2. Reuse the audit's battery shape: graded natural-language queries (2 per target, plus
   negative controls), emit hit@1/3/5 + MRR + per-query appendix as JSON receipt under
   `output/`.
3. Run post-ticket-03: the (b) numbers are the D1 after-proof and land in map Context.

## Acceptance

- `bun run scripts/recall-audit.mjs` (or the package-script form) runs offline against a
  temp corpus fixture in tests (small fixture battery, mock embedder) — CI-safe.
- Post-fold live receipt recorded in map: kcard path hit@k on the 20-question battery
  (success = ≥ 1/20; expectation much higher given the 1.00 blend).

## Verification

Script test with fixture corpus; live receipt committed under `output/` (gitignored dir is
fine — record numbers in map, path in the ticket resolution). local_ci untouched.
