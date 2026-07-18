# workflow-pack regression buildup — design

**Date:** 2026-07-18
**Branch:** `workflow-pack-regression-buildup` (off `origin/main` @ `43bdc1f7`)
**Owner:** Ziyu Huang

## 1. Goal

A single structured audit pass over the workflow-pack engine core + Path A CLI
wrapper that produces two kinds of output:

1. **Coverage-gap guards** — pin existing-but-untested behavior of the #621
   two-path shared resolver, manifest model, and CLI wrapper as regression
   tests.
2. **New-defect RCA** — re-scan the engine for `null → default` /
   silent-wrong-result patterns that crept in since the last RCA pass; fix and
   pin each.

Deliverable shape: **tests + fixes** (RCA-program style), bounded to a single
audit pass.

## 2. Scope

**In-surface:**

- `bun-apps/pi-agent-ext-workflow/src/`
  - `workflow-pack.ts` (two-path resolver + orchestration)
  - `workflow-pack-manifest.ts` (manifest model + validation)
  - `workflow.ts` (runtime: `parallel` / `pipeline` / `verify` / `judgePanel` /
    `loopUntilDry` / `checkpoint` / `withTimeout` and stdlib)
  - `errors.ts` (`classifyProviderLimit`, `wrapError`, error codes)
  - `run-persistence.ts` (atomic run-log persistence)
  - `structured-output.ts` + schema resolution
  - `workflow-tool.ts` (Path B interactive tool — `name` resolution + XOR
    contract)
- `bun-apps/pi-agent-cli/src/commands/workflow.ts` (Path A thin wrapper:
  `parseWorkflowArgs`, `buildMainSpec`, flag parsing, env precedence)

**Out-of-scope:**

- L2 extension workflow scripts (`pi-agent-ext-flux2` / `krea2` /
  `self-improve-flux2.js`) — already covered by
  `regression-ext-workflow-protection.test.ts` +
  `regression-self-improve-loop.test.ts`.
- Other pi-agent infra packages (`pi-agent` core, `pi-obsidian`, `pi-vlm`, …).

## 3. Audit dimensions

Nine dimensions. Each is fanned out to one Explore agent that returns a finding
list; **every finding is verified by hand against the source** before any change.
False positives are discarded and logged in the summary.

1. **Resolver branch completeness** — `resolveWorkflowScript` path /
   `.pi/workflows` / `package-workflows` branches, pack-over-file precedence,
   absolute path outside repo root (no root needed), `.js`-suffix candidates,
   literal-dir-without-manifest throw, error message clarity.
2. **Manifest edge cases** — `validateManifest` type / empty-string / optional
   field presence semantics (absent ≠ undefined), `readManifest` bad-JSON and
   missing-file error wording.
3. **Two-path asymmetry (high value)** — Path A `--model` overrides
   `manifest.model`; Path B does **not** apply `manifest.model` (session
   `mainModel` governs; applying it mutates shared state). This intentional
   asymmetry is the easiest thing to "fix" into a regression — it must be
   pinned on both paths.
4. **CLI wrapper behavior** — `buildMainSpec` (`model.includes("/")` check,
   provider prefix composition), `parseWorkflowArgs` bad-JSON error, `--out-dir`
   > `PI_WORKFLOWS_OUT_DIR` > default precedence, `--dry-run` skips agent.
5. **`listWorkflows` / `findRepoRoot`** — cross-path enumeration order, malformed
   single-file script goes to `errors` (not dropped), 12-iteration walk-up cap
   boundary.
6. **Engine new-defect hunt** — re-scan `workflow.ts` runtime + stdlib for new
   `null → default` instances since the last RCA (the pervasiveness pattern:
   `null→false`, `null→0`, `partial→complete`, `tier→mainModel`,
   `timed-out→uncounted`).
7. **`run-persistence.ts`** — atomic `tmp + rename` + `.bak` + `wx` lease crash
   safety. Last RCA verified this was sound but it is not currently pinned; add
   a guard so a future change cannot silently regress.
8. **`structured-output.ts` / schema resolution** — schema-retry path
   `null → default` sniff. Last RCA verified sound; pin it.
9. **`workflow-tool.ts` (Path B)** — `name` resolution + `script` XOR `name`
   contract beyond the existing four tests: `name` + `args` together, name
   resolution failure error wording, manifest arg merge already covered but
   model asymmetry (dim 3) re-checked here.

## 4. Finding → fix pipeline

Every finding runs through the same pipeline:

1. **Verify.** Read the source; confirm it is a real defect or a real gap, not a
   false positive. Discard false positives, record them in the summary.
2. **Grade.**
   - **Coverage gap** (behavior already correct, test missing) → add guard only.
   - **Low-risk fix** (no return-shape change: internal default, warning, or
     error message) → fix + guard.
   - **Contract change** (changes a return shape or semantics) → **confirm with
     user before touching**, then fix + guard.
3. **Pin guard.** Each fix or gap gets a test that fails on regression, placed
   in the appropriate `regression-*.test.ts` (new RCA number continues the
   sequence) or existing `workflow-pack.test.ts`.
4. **Green-verify.** `bun test --cwd bun-apps/pi-agent-ext-workflow` +
   `bun test --cwd bun-apps/pi-agent-cli` + `bun run --cwd
   bun-apps/pi-agent-ext-workflow build` (tsc gate, if present).

## 5. Test placement

- New RCA findings: append to
  `bun-apps/pi-agent-ext-workflow/tests/regression-rca.test.ts` under the next
  RCA numbers.
- Two-path / manifest / resolver / persistence / structured-output gaps:
  `bun-apps/pi-agent-ext-workflow/tests/workflow-pack.test.ts` or a new
  `regression-engine-gaps.test.ts` if the volume warrants a dedicated file.
- Path B tool gaps: `bun-apps/pi-agent-ext-workflow/tests/workflow-tool-pack.test.ts`.
- **CLI wrapper** (`parseWorkflowArgs`, `buildMainSpec`): a new
  `bun-apps/pi-agent-cli/tests/` directory. `pi-agent-cli` has no `tests/` dir
  today but already declares `"test": "bun test"`. `buildMainSpec` is currently a
  local function — **export it** so it is unit-testable. This keeps the test in
  the right package (no engine → cli reverse dependency).

## 6. Completion criteria (single pass)

- All nine dimensions walked once; every finding verified.
- All low-risk fixes + coverage-gap guards landed; tests green.
- Contract-change findings: each confirmed with the user, then fixed + guarded
  (or, if declined, recorded as `.todo` + GitHub issue).
- A summary table (Finding # / dimension / grade / disposition) in the PR
  description and commit message.

## 7. Risks & controls

- **False positives** — fan-out findings are verified by hand against source
  before any change.
- **Scope creep** — single pass; contract changes are not auto-fixed, each
  requires explicit user confirmation.
- **CLI test bootstrap** — `pi-agent-cli` has no test directory; this pass
  creates one and exports `buildMainSpec`. If exporting proves intrusive, the
  fallback is to test the equivalent behavior at the engine layer via its
  injectable interfaces (decided per-finding).
- **Determinism** — all guards use the injectable fs / stub-agent harness
  already established by the existing regression suites (no disk, no LLM, no
  GPU).
