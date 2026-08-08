---
type: task
blocking: 02
status: open
---

# 04 — Rewire await_pr_merge to gate on local_ci

## Question

Implement ticket 01's decision: make `await_pr_merge` merge only when `local_ci` (ticket 02) passes, replacing the current un-gated immediate-merge (remote checks absent = green).

## What to build

- `await_pr_merge` invokes the `local_ci` tool (changed-package typecheck + tests vs origin/main) as its gate. On green → `gh pr merge --squash` (no `--auto`); on red → do NOT merge, return the local_ci failure detail.
- Drop the remote-check-polling / `--auto` / enable-auto-merge path (CI disabled; never-wait rule). Keep abort/timeout/progress plumbing where it still applies.
- BEHIND handling: decide keep-simple-rebase vs drop entirely (the force-push-to-rerun-CI rationale is gone). Default proposal: keep a best-effort `git pull --rebase`, no force-push.
- Naming: `await_pr_merge` is now a slight misnomer (nothing to "await" but local CI). Decide rename to `merge_pr` / `ship` vs keep. Default proposal: rename to `merge_pr`.
- Preserve the structured `RecipeOutcome` return; add a `localCi` field (pass/fail + per-package detail) to the outcome.

## Acceptance

- [ ] Merge blocked when `local_ci` fails (no merge call issued); failure detail returned
- [ ] Merge proceeds (squash, no `--auto`) only when `local_ci` is green
- [ ] Remote-check polling / `--auto` / enable-auto-merge path removed
- [ ] BEHIND handling decision made + implemented (simple rebase or drop)
- [ ] Rename decision made + applied consistently (registration, tests, docs)
- [ ] `RecipeOutcome` gains a `localCi` field; existing tests updated; new tests cover green-gate and red-block paths
- [ ] Works with remote CI disabled (no network dependency in the gate)

## Resolution

Settled decisions for the implementation (code committed under `bun-apps/pi-agent-ext-devops/`; this section stays working-tree only):

- **Dropped the remote poll-loop entirely.** `await_pr_merge` is now a single-shot LOCAL-CI-GATED merge. No `Sleeper`, no `clock`, no `timeoutMs`, no `pollIntervalMs`, no `onProgress`/`ProgressUpdate`, no `decideRecipeAction`/`runRecipeLoop`. The vestigial `src/progress.ts` (poll-loop TUI formatter) + its test were deleted; `src/pr-logic.ts` keeps only the shared domain types (`PrState`/`MergeState`/`CheckTally`).
- **Pure enforcement — no escape hatch.** A red gate (incl. `detectionError`) OR a thrown runLocalCi (e.g. base ref unresolvable) → BLOCK with `merged:false`; the merge is never issued. No `--force`, no skip flag.
- **BEHIND blocks (no auto-rebase).** A green gate + `mergeState==="BEHIND"` → block with the "rebase locally + re-push, then re-run" message. The force-push-to-rerun-CI rationale is gone (no remote CI to rerun).
- **Rename deferred.** `await_pr_merge` keeps its name (registration, manifest, callers unchanged); the slight misnomer is accepted over the cross-file churn. `src/pr-logic.ts` likewise keeps its filename though it now holds only types.
- **Embedded local_ci uses the PR's fetched base/head.** `runMergeRecipe` calls `runLocalCi({ baseRef: "origin/"+baseRefName, headRef: "origin/"+headRefName })` where baseRefName/headRefName come from `gh pr view --json baseRefName,headRefName`. A best-effort `git fetch origin <base> <head>` runs first (exit code IGNORED — offline-safe; a failed fetch surfaces fail-closed via a missing-ref detectionError or a thrown rev-parse).
- **strict:false, includeGates:true** on the embedded local_ci (the v1 blocking gates run; audit gates do not).
- **detectionError blocks** (already handled by `ci.overall !== "pass"`; the error message prefers `ci.detectionError` when present).
- **Dead code removed:** `enableAutoMerge` + `rebaseAndForcePush` dropped from `GhClient` + `createGhClient` (+ their gh.test.ts cases), confirmed unused outside the deleted poll-loop. `mergeNow` stays as-is (direct `gh pr merge --${strategy}`, no `--auto`, throws on non-zero). `parsePrView`/`prStatus` extended to also request+expose `baseRefName`/`headRefName`.
- **Strategy default → "squash"** (matches the repo's `gh ship` convention); `merge`/`rebase` still accepted.
- **Verified:** `bun run check` (tsc clean) + `bun test` (98 pass / 0 fail), incl. the 8 required recipe gates (green/red/detection-error/behind/non-clean/already-merged/closed/fetch-fail→block) + 5 robustness cases.
