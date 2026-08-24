# 04 — shared test-utils: one makeMockPi + one spawn harness + one tmpdir helper

Source: map Context "Tests" harness-duplication cluster (~150-250 LOC; net target −100-150). Depends on 03 (deletions land first, helpers consolidate what remains).

## Scope

- **makeMockPi ×3 → 1**: variants at `src/__tests__/extension-contract.test.ts:46-87`, `src/cli/__tests__/tool-name-contract.test.ts`, `src/__tests__/extension-shortcut-guard.test.ts`. Shared home inside the package (a `src/__tests__/test-utils.ts` — NOT cross-package; that is map D3 follow-up). Equivalence: merged helper must record the same tool/command/shortcut surface all three suites assert on.
- **Spawn harness ×8 → shared**: promote `src/cli/__tests__/e2e/_helpers.ts` runCli as the canonical runner; wrap (not move — imported by name across suites) so boot-smoke runCanary, cli-sh-main-argv runCliSh (48 LOC incl. PATCH_TABLE env-gate loop), e2e-launcher run(), e2e-image-agent runLauncher, patch-outcome, ext-new, sh/adhoc-extensions, bundle-mode-anchor reuse one core. Keep per-suite env/argv prep at the call sites; share the spawn/drain/exit-code plumbing only.
- **tmpdir boilerplate ×17 → helper**: mkdtempSync + beforeEach/afterEach rmSync one-liner (worst: cli/__tests__/doctor.test.ts 10 uses, sh/adhoc-extensions.test.ts 6, run-dir/resolve.test.ts 4, pipeline-gate.test.ts 4).

## Acceptance criteria

- [ ] Exactly one makeMockPi / one spawn core / one tmpdir helper in the package (grep receipts)
- [ ] e2e tier green via ext-devops run-test.ts (full, not hand-picked)
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; net test LOC delta recorded
- [ ] devops local_ci green; PR merged via devops chain; reviewer pass
