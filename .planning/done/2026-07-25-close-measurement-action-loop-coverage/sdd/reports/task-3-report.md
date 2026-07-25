# Task 3 Report — wire coverage into qa/run.ts

**Status:** DONE

## Summary

All 8 edits from `task-3-brief.md` applied verbatim to `bun-apps/pi-agent-ext-tool-gate/qa/run.ts`. The coverage QA (Tasks 1–2) is now wired into the unified gate: report block, `--coverage-threshold` flag, `coverage`/`coverageProblems` on `QaResult`, a `coverage:` summary line, a `coverage` JSON key, and a `--strict`-only coverage gate folded into the verdict.

## Edits applied (all verbatim from brief)

1. **Import** — added `measureCoverage`, `formatCoverage`, `assertSane as assertCoverageSane`, `type CoverageReport` from `./coverage.ts`. The alias avoids the name clash with savings' own `assertSane` (both modules export it).
2. **`QaOptions.coverageThreshold?: number`** — added.
3. **`QaResult`** — added `coverage: CoverageReport` and `coverageProblems: string[]` (after `savingsProblems`).
4. **`runQa` body** — replaced. Measures coverage; folds `coverageProblems` into `sane`; adds `strictCoverageOk = coverage.ungated.length === 0`; gates on coverage under `--strict` only (`pass = (opts.strict ? intendedOk && strictOk && strictCoverageOk : intendedOk) && savingsFloorMet`); reason chain gains a coverage branch. Existing savings/L1/l2 verdicts preserved.
5. **`formatReport`** — `## Coverage` block inserted after the Savings floor line, before `## Layer-1 capability`.
6. **`formatJson`** — `coverage` key (7 fields incl. `structuralProblems: r.coverageProblems`) inserted after the savings block.
7. **`main()` summary** — `coverage:` line inserted after `L1:`, before `capability:`.
8. **`parseArgs`** — `--coverage-threshold` branch added after `--root`.

## Verification

### 1. Typecheck

The brief's literal command `( cd bun-apps/pi-agent-ext-tool-gate && bunx tsc --noEmit )` cannot run as-is: `pi-agent-ext-tool-gate` has **no `tsconfig.json` and no local `typescript`** (unlike sibling ext packages such as `pi-agent-ext-workflow`, which ship both). With neither a project file nor input files, `bunx tsc --noEmit` prints the tsc help and exits 1 — this is an environment gap, not a code defect.

To still obtain a real typecheck of `qa/run.ts`, a throwaway `tsconfig.json` (matching `pi-agent-ext-workflow`'s compiler options + `allowImportingTsExtensions`, `noEmit`, including only `./qa/run.ts`) was created in-tree, run, then deleted:

```
qa/evaluate.ts(117,3): error TS2322: ... 'note: string | undefined' not assignable to 'note: string'
```

That **single** error is **pre-existing** — it reproduces identically on the original `qa/run.ts` (verified via `git stash`), lives in `qa/evaluate.ts` (a file this task must not touch), and is surfaced only because `run.ts` transitively imports `evaluateCorpus`. **`qa/run.ts` itself is type-clean** — my edits introduce zero new type errors.

Recommendation (out of scope for this task): add a `tsconfig.json` to `pi-agent-ext-tool-gate` so the documented `bunx tsc --noEmit` works; and fix the `note: string | undefined` typing in `qa/evaluate.ts:117`.

### 2. Full suite

```
( cd bun-apps/pi-agent-ext-tool-gate && bun test )
→ 226 pass / 0 fail / 488 expect() calls  (incl. coverage integration test ~135ms)
```

### 3. `bun run qa` (default) — primary

```
✅ PASS — savings floor met + L1 intended-behavior holds; task-breaking gates + coverage reported (use --strict to gate on them)
savings:   8,590 tok/req (50%) — OFF 17,171 → ON 8,581  [floor ✅ · vs ~8,500: +90]
L1:        must-fire 39/39 · must-not-fire 22/22 · escape-name 12/12 · escape-intent 12/12
coverage:  0 ungated heavy tool(s) · 22 gated-heavy  [✅ non-gating]
capability: 0 task-breaking gate(s) · 13 benign false-fire(s) [never gate]
→ exit 0
```

Written report (`output/tool-gate-qa-report.md`) contains the `## Coverage` block (between Savings and Layer-1):

```
## Coverage
threshold:   300 tok/req
tools:       56 total · 22 heavy (excl. builtins) · 22 gated-heavy ✅
ungated:     0 heavy tool(s) not tracked by any gate

✅ every heavy tool is tracked by a gate (or is a builtin)
- coverage verdict: ✅ complete — non-gating by default
```

### 4. Secondary modes (budget allowed)

- **`--strict`** → exit 0; coverage line shows `[✅ --strict gates]`. The repo is currently **fully gated** (0 ungated heavy tools, 22/22 gated-heavy), so the new coverage gate passes under `--strict`. No ungated gap surfaced.
- **`--json`** → `coverage` key present with all 7 fields (`threshold`, `totalTools`, `heavyTools`, `gatedHeavy`, `ungated: []`, `pass: true`, `structuralProblems: []`).
- **`--coverage-threshold 200`** — not run (budget; override path is `opts.coverageThreshold → measureCoverage(root, threshold)`, exercised structurally by the suite).

## Self-review

- ✅ Alias `assertSane as assertCoverageSane` correct — no name clash; savings' `assertSane` still used for `savingsProblems`.
- ✅ Verdict logic matches brief verbatim (copied, not improvised): `strictCoverageOk`, the `--strict && !strictCoverageOk` reason branch, and the `pass` ternary all byte-for-byte from the brief.
- ✅ Existing verdicts preserved: `savingsFloorMet`, `intendedOk`, `strictOk`, false-fires-excluded semantics all intact; coverage is purely additive (folds into `sane` + adds a `--strict`-only term).
- ✅ Only `qa/run.ts` touched (git diff stat: 1 file, +36/-4). No Task 1/2 files (coverage.ts, coverage.test.ts, package.json) modified.

## Concerns

- **Environment**: `pi-agent-ext-tool-gate` lacks a `tsconfig.json` and local `typescript`, so the brief's literal `bunx tsc --noEmit` prints help instead of typechecking. Worked around with a throwaway in-tree tsconfig (created, run, deleted). `qa/run.ts` is type-clean; the only error is pre-existing in `qa/evaluate.ts:117`. Flagging for the orchestrator — not a defect of this task.

## Commit

`6b0bec5f` — `feat(tool-gate): wire coverage into qa/run.ts (report + --coverage-threshold + --strict gate)`
