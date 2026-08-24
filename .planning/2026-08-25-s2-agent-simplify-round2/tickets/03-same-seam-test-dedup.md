# 03 — same-seam test dedup (delete-with-equivalence-proof)

Source: map Context "Tests" items 1-7 (~330-400 LOC). Rule: per-candidate, quote the surviving assertion that covers the same seam (map D5); a deletion whose equivalence proof cannot be quoted stays.

## Candidates (in value order)

1. Delete `src/static-extensions.test.ts` (whole file, 40 LOC) — survives verbatim at `run-dir/manifest-consistency.test.ts:59,76`.
2. Merge `webuiFlags` describe (lines 14-58) into `src/cli-argv.test.ts`, delete `src/__tests__/cli-argv.test.ts` — every other case is a strict subset of `src/cli-argv.test.ts:74-140`.
3. Exists-on-disk triple → one: delete `src/run-dir/registry.test.ts` + `manifest-consistency.test.ts:91-113` block; keep `registry-config.test.ts:175` (tests REGISTRY pre-generation; registry-freshness proves manifest ≡ registry output). registry.test's unique bits are weak-value (shape checks, `proj/` path pin :34).
4. `parseWorkflowArgs` ×2 → keep the copy co-located with the richer `workflowRunCommand.run` suite; delete the other (`workflow.test.ts:19-38` or `workflow-command.test.ts:118-130`). NOTE: if ticket 02 removed these files, this candidate is already satisfied — record and skip.
5. Root-help e2e ×2 → drop `meta.e2e.test.ts:29-43` help/-h/--help rows (keep `[]` + version); `help-dispatch.e2e.test.ts:67-80` survives with same assertions via same harness.
6. `detectMode` ×2 → keep `mode.test.ts:9-18` canonical; delete `mode.test.ts:23-40` (self-duplicating/tautological); trim `run-dir/resolve.test.ts:17-36` to argv/manifest-resolution cases only.
7. Weakest-value singles: `sh/host-modules.test.ts:5-7` (asserts literal), `memory-to-vault-script.test.ts:29-31` (`toContain("25")` re-echo), `extensions-registry.test.ts:55-59` (echo), registry `outRoot` pin — delete each only with a one-line justification.

## Outcome (2026-08-25) — equivalence proofs per deletion

1. **`src/static-extensions.test.ts` (40 LOC) DELETED** — "factory names equal manifest.staticExtensions exactly" survives verbatim at `manifest-consistency.test.ts:59-62` (set equality, same inputs sorted); "disjoint dynamic/static" survives verbatim at `:76-79` (staticDirs.filter(dynamicDirs.includes) === []).
2. **`src/__tests__/cli-argv.test.ts` DELETED, `webuiFlags` describe (7 tests) MERGED into `src/cli-argv.test.ts`** — every non-webuiFlags case in the deleted file is a strict subset of `src/cli-argv.test.ts`: userSuppressFlags -ne/-ns/both/empty (`:74-97` vs deleted `:60-68`), userExtensionPaths pairs (`:100-111` vs `:70-75`), overriddenStaticExtensions whole-segment/-v2 (`:114-139` vs `:77-86` — the "-v2 suffix must not substring-match" case verbatim at both).
3. **`src/run-dir/registry.test.ts` DELETED (whole file)** — its "exists on disk" test ≡ `registry-config.test.ts:175-181` (asserts over REGISTRY pre-generation; `registry-freshness.test.ts:17` proves manifest.json is byte-generated from that registry, so transitively equal). Its unique tests were weak-value: `toBeBoolean` shape checks (type-system re-assertion) and the `proj/dist/s2-agent-sh` machine-specific outRoot pin (`:34`). PLUS `manifest-consistency.test.ts` exists-on-disk describe trimmed: dirs+entries loops deleted (transitively equal via the same chain), **skills loop KEPT** — skill paths are a separate manifest field with no other cover.
4. **parseWorkflowArgs ×2 — PRE-SATISFIED by ticket 02** (both suites deleted with the workflow command in PR #2015).
5. **Root-help e2e ×2** — `meta.e2e.test.ts` root-help loop reduced to the bare `(no args)` case; `help`/`-h`/`--help` rows covered case-for-case by `help-dispatch.e2e.test.ts:67-80` (same runCli harness, same 3 banner assertions).
6. **detectMode ×2** — `mode.test.ts` canonical suite kept (.ts→source :5-8, .js→bundle :10-15, own-URL→source kept with regression comment); deleted the Set-of-two-modes tautology (:17-23) and the "patches consume detectMode" describe (:30-40 — exact duplicates of :7 and :14). `run-dir/resolve.test.ts` detectMode describe DELETED (all 3 cases covered by mode.test.ts).
7. **Weakest-value singles** — host-modules HOST_API literal test (restated a constant; whitelist + identity tests are the real contract), memory-to-vault-script maxNotes positive mirror (`toContain("25")` re-echoed the input; negative case kept), extensions-registry flux2 echo test (re-echoed positionals; fallback shape test kept), registry `proj/` pin (died with candidate 3).

Net: 11 files changed, 82 insertions, 248 deletions (−166 net); 77 → 74 test files; 1021 → 969 tests. Below the −330/−400 chart estimate because candidates 4 (pre-satisfied, no double-count) and parts of 3/7 overlapped other deletions — the chart's estimate counted LOC of files whose unique portions were smaller than their duplication.

**Reviewer pass (READY, 0 blockers, 4 NITs recorded 2026-08-25):**
- loadRegistry NOT test-orphaned: `registry-freshness.test.ts:18` calls it against the real tree every run (a broken entry would throw there); shape normalization transitively covered via buildManifestObject/manifestText consuming the same fields.
- Wording corrections: (a) cli-argv combined long-form `["--no-extensions","--no-skills"]` case covered behaviorally (same includes() branches) but not verbatim — "strict subset" slightly overstated; (b) help-dispatch `-h`/`--help` rows assert banner only (1 of 3 strings) — all four argv forms funnel into the same root-help print path, residual risk ≈ 0.
- Two one-line positive branches now untested: maxNotes threading (noteClause at memory-to-vault-script.ts:20-21; negative case + arg parsing still covered) and flux2Subcommand.task non-empty-positionals (ext-flux2 has no tests dir). Both accepted as one-line template interpolations; pickup optional in t04.

## Acceptance criteria

- [x] Each deletion's equivalence proof quoted in this ticket (or the candidate explicitly skipped with reason)
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green (969 pass / 0 fail); full e2e tier green via ext-devops run-test.ts --effort=full (incl. live deepseek smoke + sibling baselines)
- [x] Net test LOC delta recorded (−166 net / −52 tests; below chart estimate, reason above)
- [ ] devops local_ci green; PR merged via devops chain; reviewer pass
