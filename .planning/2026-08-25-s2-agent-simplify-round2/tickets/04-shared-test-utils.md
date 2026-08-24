# 04 — shared test-utils: one makeMockPi + one spawn harness + one tmpdir helper

Source: map Context "Tests" harness-duplication cluster (~150-250 LOC; net target −100-150). Depends on 03 (deletions land first, helpers consolidate what remains).

## Scope

- **makeMockPi ×3 → 1**: variants at `src/__tests__/extension-contract.test.ts:46-87`, `src/cli/__tests__/tool-name-contract.test.ts`, `src/__tests__/extension-shortcut-guard.test.ts`. Shared home inside the package (a `src/__tests__/test-utils.ts` — NOT cross-package; that is map D3 follow-up). Equivalence: merged helper must record the same tool/command/shortcut surface all three suites assert on.
- **Spawn harness ×8 → shared**: promote `src/cli/__tests__/e2e/_helpers.ts` runCli as the canonical runner; wrap (not move — imported by name across suites) so boot-smoke runCanary, cli-sh-main-argv runCliSh (48 LOC incl. PATCH_TABLE env-gate loop), e2e-launcher run(), e2e-image-agent runLauncher, patch-outcome, ext-new, sh/adhoc-extensions, bundle-mode-anchor reuse one core. Keep per-suite env/argv prep at the call sites; share the spawn/drain/exit-code plumbing only.
- **tmpdir boilerplate ×17 → helper**: mkdtempSync + beforeEach/afterEach rmSync one-liner (worst: cli/__tests__/doctor.test.ts 10 uses, sh/adhoc-extensions.test.ts 6, run-dir/resolve.test.ts 4, pipeline-gate.test.ts 4).

## Outcome (2026-08-25)

- **New `src/__tests__/test-utils.ts`** (the ONE in-package home): §1 `makeMockPi` (union of all three former variants — records tools + commands + shortcuts + onCount, full no-op surface incl. getThinkingLevel/z/events.off/once), §2 `spawnCaptureSync` / `spawnCaptureAsync` (spawn + pipe + drain + exitCode-null→-1 coercion), §3 `tempDir` / `cleanupTempDirs` (registered afterAll cleanup).
- **makeMockPi ×3 → 1**: extension-contract (canonical recorder; `mock.pi.onCount` usage → `mock.onCount`), tool-name-contract (name-set derived from recorded tools), extension-shortcut-guard (per-factory mock, shortcuts labeled with the extension externally). All three suites green unchanged.
- **Spawn core adopted at 8 sites**: e2e/_helpers runCli, boot-smoke (runCanary + prebuild), patch-outcome ×2 (`-e` script runners), adhoc-extensions ×2, cli-sh-main-argv runCliSh (async; env/PATCH_TABLE prep stays at call site), ext-new (scaffold + self-test spawns), bundle-mode-anchor (build + boot). NOT migrated (semantics genuinely differ): e2e-launcher `run` (node spawnSync + 15s timeout), e2e-image-agent `runLauncher` (timeout-kill timer).
- **tmpdir: scope honestly REDUCED from ×17 → 2 conversions + 1 leak fix.** Converted e2e-launcher (beforeAll/afterAll) and cli-sh-main-argv — the latter had a DEAD `dirs[]` nothing ever pushed to (runCliSh's mkdtemp dirs leaked per run; now tempDir-registered, afterEach cleanup — a real fix). The other 15 files use per-test try/finally rmSync — converting them would change cleanup TIMING (per-test → file-end), a semantics change dressed as dedup; deliberately not done.
- Net numstat (reviewer-corrected 2026-08-25): dedup deleted **−208** across 11 files; new helper **+163** → **all-in +40**. The charter's "net −100-150" target is met only counting deletions (−208); the honest all-in number is +40 and the target line in this ticket's Scope was mismeasured at chart time (it assumed the helper would cost ~40 LOC, not 163). The dedup itself is real: 12 former private spawn/mock plumbing sites now share one home. Spawn core: 12 call sites across 7 files. Gates: tsc clean, 969 pass / 0 fail, full e2e tier via run-test.ts, local_ci pass 111.2s.

## Acceptance criteria

- [x] Exactly one TEST makeMockPi / one spawn core / one tmpdir helper in the package (src/__tests__/test-utils.ts; the only other in-package `makeMockPi` is ext-doctor.ts:50 — a PRODUCTION runtime probe, deliberately not folded into a tests dir)
- [x] e2e tier green via ext-devops run-test.ts (full, not hand-picked)
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; numstat recorded honestly (−208 deletions / +163 helper / +40 all-in)
- [ ] devops local_ci green; PR merged via devops chain; reviewer pass (local_ci pass 111.2s; reviewer READY 2 NITs fixed; merge pending)
