# 14 — memory-diff audit per distill converge run

- **Phase:** P3 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open

## Problem

Converge runs create/merge/supersede cards with no per-run audit trail — OpenViking writes
a `memory_diff.json` per commit; our equivalent state (`.distill-state.json`) records
thresholds/history but not field-level effects. Post-hoc "what did that run change?" is
unanswerable without git archaeology on the vault submodule.

## Approach

1. `src/distill/state.ts`: beside `.distill-state.json`, write `.distill-diff.json` per
   converge run — `{runId, created[], merged[](with per-field ops from the D4 table),
   superseded[], skipped[](reason)}` — atomic tmp+rename (same pattern as checkpoints).
2. `runConverge` returns the diff; the `zk_ingest` `converge` action surfaces a one-line
   summary (counts) in its tool output; full diff stays in the file.
3. Replay verification: a test reconstructs the post-run vault by applying the diff to the
   pre-run snapshot (created/merged fields only — supersede is a frontmatter flip).

## Acceptance

- Diff written atomically every converge run; crash mid-run leaves the previous diff intact.
- Replay test green; converge e2e test (`__tests__/distill/pipeline`) asserts diff presence
  + shape.
- Vault git status: only the intended card changes + the two state files.

## Verification

Canonical kcard gates; one real distill run receipt (counts line) recorded in the ticket
resolution.
