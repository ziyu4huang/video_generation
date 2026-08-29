# 14 — memory-diff audit per distill converge run

- **Phase:** P3 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-30 (PR #2163)

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

## Resolution (2026-08-30, PR #2163)

Shipped as `DistillDiff` types + `writeDiff`/`readDiff` (atomic tmp+rename, the checkpoint
pattern) in `src/distill/state.ts`, computed in `runConverge`: pre-run snapshot of the
notes' canonical card paths → post-run per-card frontmatter+body diff → field ops
(`union` only for append-only supersets — the D4 merge-op table's array semantics;
`replace` otherwise; a write path that diverges from the slug guess carries a coarse
whole-card replace, never a fabricated field list). `superseded[]` from markSuperseded
found flags; `skipped[]` from a new optional `killed` param (id+reason+detail, additive
zk_ingest schema param fed by the gate's report). `runId` joins to
`DistillState.history[].ts`. `ConvergeResult.diff` returns the diff; the converge action
prints a one-line counts summary + `details.diffFile` (full diff stays in the file).

- Tests: `__tests__/distill/diff.test.ts` (8) — atomic writer (failing serialization
  leaves the prior diff byte-identical, no tmp debris), full shape, REPLAY (ops applied
  to the pre-run snapshot == real post-run card on EVERY field; unmentioned fields
  proven unchanged), supersede frontmatter flip, crash-mid-run intactness (ingest
  failure leaves the previous diff), idempotent no-op diff; pipeline e2e asserts diff
  presence + shape. kcard 787 pass / 0 fail, tsc clean, local_ci pass (116s).
- Real-run receipt (`output/distill-diff-receipt/RECEIPT.md`, real-vault copy):
  run 1 `memory-diff: 1 created, 0 merged, 0 superseded, 1 skipped` (seeded gate-kill
  recorded); run 2 (enriched v2, same id) `0 created, 1 merged` with ops
  `tags:union, confidence:replace, body:replace`. Vault file-level effect: 1 new card +
  the two state files + the deterministically regenerated MOC — nothing else.
- Reviewer (#2163 fork, APPROVE, 6 findings) pre-merge fixes: reorder-only array
  changes now classify as `replace` (was a no-op `union []` — reviewer finding 2,
  regression-pinned by 3 unit tests on the exported `diffCardOps`); `writeState`
  upgraded to the same tmp+rename (finding 4 — the torn-state crash window that
  orphaned the runId join is gone). Documented residuals: (a) finding 1 —
  `.distill-diff.json`(+`.tmp`) needs a VAULT-side .gitignore entry (the
  `.distill-state.json` pattern) via vault PR + gitlink bump, the t11 SOP — fold-back;
  (b) finding 3 — replay covers MERGED frontmatter fields only (created entries carry
  no payload; `body`/`*` ops are coarse markers); (c) finding 5 — `skipped[]` trusts
  the caller's `killed` report, no cross-check against `metrics.killed`.
