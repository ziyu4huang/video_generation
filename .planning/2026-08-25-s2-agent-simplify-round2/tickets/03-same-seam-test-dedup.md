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

## Acceptance criteria

- [ ] Each deletion's equivalence proof quoted in this ticket (or the candidate explicitly skipped with reason)
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green (full e2e tier via ext-devops run-test.ts)
- [ ] Net test LOC delta recorded (target ≈ −330 to −400)
- [ ] devops local_ci green; PR merged via devops chain; reviewer pass
