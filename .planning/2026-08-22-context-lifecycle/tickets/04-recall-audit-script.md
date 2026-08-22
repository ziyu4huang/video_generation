# 04 — committed recall-audit harness + post-fold baseline

- **Phase:** P0 · **Package:** `s2-agent-ext-hermes-memory` (script) · **Status:** closed 2026-08-22

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

## Resolution (2026-08-22)

- **Script home DECISION: `bun-apps/scripts/recall-audit.mjs`, NOT hermes `scripts/`.** The
  harness needs both `SurrealClient` (hermes, TIER-0) and `retrieveRecords` (knowledge-card,
  TIER-1); the dep-guard tier rule forbids a hermes→knowledge-card import edge in any form,
  so the script lives at the neutral workspace level above both tiers. The CI-safe fixture
  test (`s2-agent-ext-hermes-memory/scripts/recall-audit.test.ts`) spawns the script as a
  subprocess — no import edge; hermes `bun test` picks it up, so no local_ci change.
- Battery: `bun-apps/scripts/recall-audit-battery.json` — journal arm = the original 20
  graded queries verbatim (targets = hermes MEMORY.md mdIds); kcard arm = 20 paraphrases
  over 10 real vault cards (targets = card filename/id substrings + same-fact twin cards —
  the vault often holds one fact as 2–3 distilled cards; a hit is "a card that answers the
  query", not "one arbitrary card"). Corpus coverage is probed before scoring: target-absent
  queries report separately and never count as retrieval misses.
- **Post-fold live receipt (2026-08-22, `output/recall-audit/receipt-2026-08-22T11-27-22-314Z.json`):**
  - journal arm (Surreal `memories`, folded exact-match lexical): hit@1/3/5 = **0/20**,
    MRR 0.000 — reproduces the 2026-08-19 audit verbatim; post-fold the journal is
    capture-only by design, not a recall surface. D1's before-number, unchanged.
  - kcard arm (`retrieveRecords`, bodyMatch+slugDom+semantic bge-m3 live, semanticUsed=true,
    coverage 20/20): **hit@1 11/20, hit@3 16/20, hit@5 17/20, MRR 0.688**. Success gate
    (≥1/20) cleared 17× over. The 3 remaining misses (macos-timeout paraphrase, dark-beast
    quantization paraphrase, "keep VLM checks out of bun test skeleton") are the documented
    generic-tag-crowding / twin-dispersion weaknesses — ticket 05+ territory, not harness
    artifacts.
  - Negatives: journal returns 0 rows (clean); kcard returns 5 rows for negatives
    (ANY-token bodyMatch semantics — top1s are vacuous, recorded in receipt).
- Gates: hermes suite green incl. the new fixture test; fixture path is fully offline
  (`--test-embedder` deterministic hashing embedder; semantic blend exercised, zero network).
