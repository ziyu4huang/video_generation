# Spec — self-arc-18: gate fidelity (the audit instrument, check scripts, and the measured truth about the "64 reds")

Effort: `.planning/2026-09-09-self-arc-18/` · Created 2026-09-09 · Status: seeded

## Problem Statement

The self-develop series closed (arcs 3–17, #2236) naming a "test-hygiene arc"
because its audit reported 64 failing tests across file2md + hyperframes and a
systemic lint gap. A hands-on re-verification of every finding on current main
(2026-09-09, tip 6d225ca2) shows the instrument, not the packages, produced
most of the reds:

- **file2md** "30 fail / 3 errors" was a stale workspace install —
  `tesseract-wasm` declared but missing, causing 23 load errors that hid ~172
  tests (148 discovered vs 320 after install). After the sanctioned
  `bun install` (from `bun-apps/`): **319 pass / 1 named skip / 0 fail, exit 0**.
- **hyperframes** "34 fail / 325 pass" was the audit running bare `bun test`
  instead of the package's own script (`bun test tests/` = 60/60 green); the
  bare run sweeps 49 vendored test files from `node_modules/@hyperframes/*`
  (359 tests, 31 fail / 7 skip today, exit 1).
- The **19/26 packages without a `check` script** finding is CONFIRMED exactly
  (7 have it): local_ci resolves gates by script name, so lint silently skips
  for those packages.
- The **sv-analyzer "silent wasm skips"** note is a non-issue: the skips are
  `describe.skipIf(!existsSync(wasm))` with the regeneration policy documented
  in the test file header, and bun prints the skip names.

Meanwhile the tool that produced the wrong verdicts is committed and is the
series' dogfood hinge: `s2-agent-ext-ultracode/samples/audit-ext-packages.js`
hard-codes `bun test` (step 3 of the child prompt) and has no install
preflight — violating its own map's rule ("derive its command list from each
package.json's scripts, not assume a fixed triple") and ignoring arc-17 D8
(dangling/stale installs produce fake reds).

Anyone consuming the audit's verdicts — the maintenance-mode loop this series
just committed — is currently measuring with a bent ruler.

## Solution

Make every gate in the self-develop loop honest about what it ran and what it
skipped:

1. The audit workflow derives each gate command from the package's own
   `package.json` scripts (recorded per-gate in the output schema), and runs an
   install preflight before measuring, so stale installs surface as a distinct
   verdict instead of fake reds.
2. devops `local_ci` reports gates it skipped because the script is absent
   (skip-with-reason in the outcome), never a silent pass.
3. All 26 ext packages define a `check` script derived from their existing
   tooling, pinned by a workspace contract test.
4. The audit is re-run for real over all 26 packages as the arc's receipt, and
   the arc-17 dispositions are corrected in the maps (the "64 failing tests"
   framing superseded by measured receipts).

## User Stories

1. As a maintenance-mode operator, I want the audit tool to run each package's
   canonical gate script, so that a package that scopes its tests (`bun test
   tests/`) is not failed for vendored dependency tests it does not own.
2. As a maintenance-mode operator, I want the audit output to name the exact
   command each gate ran, so that a red verdict is reproducible by re-running
   that one command.
3. As a maintenance-mode operator, I want a stale workspace install to show up
   as its own verdict (or a preflight failure), so that dependency drift never
   masquerades as broken code.
4. As a developer merging a PR on this Linux box, I want local_ci to say
   "check: skipped (no script)" loudly when a package has no check script, so
   that silent lint gaps are visible in the merge chain.
5. As a developer of any ext package, I want a `check` script that matches my
   package's tooling (biome or tsc), so that my gate is linted like the rest of
   the workspace without inventing new tooling.
6. As a future session reading the maps, I want the arc-17 "test-hygiene
   successor" corrected to point at measured reality, so that nobody re-fixes
   64 phantom test failures.
7. As the series' owner, I want one real audit re-run over all 26 packages as
   the closing receipt, so that "the loop measures honestly" is demonstrated,
   not argued.

## Implementation Decisions

- **Canonical gate = the package's script, never a bare command.** The audit
  child prompt is generated per package from `package.json` `scripts`
  (`check` / `typecheck` / `test`); a gate with no script is recorded as
  `absent`, not failed and not passed. Bare `bun test` remains only as a
  documented last-resort fallback for packages with no test script (currently
  zai-mcp), and is labeled as such in the output.
- **Per-gate provenance in the schema.** The auditor result schema gains the
  exact command string per gate (e.g. `testCommand: "bun test tests/"`) so any
  verdict is re-runnable verbatim — this is arc-17 D3 (executor re-run is the
  receipt) made mechanical.
- **Install preflight before measurement.** The audit driver runs the
  workspace install (`bun install` from `bun-apps/`, the sanctioned form)
  before fanning out, and records it in the run receipt. A gate that fails with
  module-resolution errors is classified `env-drift`, a distinct verdict from
  red — matching the file2md receipt.
- **local_ci skip-loudness.** When local_ci resolves a gate by script NAME and
  the script is absent, the outcome reports the gate as skipped-with-reason
  (per package), visibly in the summary — the "silently skipped" systemic
  finding, fixed at the consumer side.
- **check-script derivation rule.** Packages with a biome config get
  `"check": "biome check ."`; packages whose only existing gate is tsc get
  `"check": "tsc --noEmit"` (the devops/hermes-memory precedent); no package
  gets new tooling invented. The mapping table is recorded in the ticket PR.
- **Workspace contract test.** One test (devops tests, beside the
  scripts-dir-contract precedent) pins: every `bun-apps/s2-agent-ext-*`
  package.json defines `check` (and `test`), so the census cannot regress.
- **One arc, per-ticket PRs** through the devops chain; planning artifacts
  (this spec, map, tickets) ride the first PR per the standing commit rule.

## Testing Decisions

- The audit script's static-contract test (`tests/audit-ext-packages.test.ts`,
  fake runner) extends to pin per-package command derivation: a package with
  scoped scripts yields the script command; a gateless package yields `absent`;
  the child prompt embeds the derived commands.
- local_ci skip-loudness is pinned by a unit test with a fixture package.json
  lacking `check`: the outcome contains the skip-with-reason entry, exit code
  semantics unchanged.
- The contract test is the check-script regression pin (26/26, exact list
  derived from the filesystem, not hard-coded names).
- The arc's end-to-end receipt is the real audit re-run (PI_MODEL=zai/glm-5.3):
  expect 26/26 gates green-or-named-skip, with file2md and hyperframes passing
  via their canonical scripts, recorded in `Shipped-as`.
- Highest-value seams: the audit script's command derivation (pure, unit-testable
  with fixture package.json objects) and local_ci's gate-resolution report.

## Out of Scope

- Fixing real first-party test failures — none are currently known; if the
  re-run surfaces real reds, they are recorded as successor material, not
  absorbed here (arc-17 triage rule).
- #2179 receipt, merge-chain MC tickets, tui-drive screenText-freeze audit,
  rpc-pair widening, turn-time instrumentation (arc-17's other named
  successors — maintenance-mode queue, untouched here).
- Env-gating the heaviest suites (PI_AGENT_E2E, deploy e2e, ML lanes) as a
  periodic lane — improvement-room material, recorded, not built.
- CI infrastructure beyond this box's local chain.
- hyperframes vendored-dependency test failures themselves (they are
  `@hyperframes/*` packages' own tests swept by a bare run; the fix is to stop
  running bare, not to fix the vendored tests).

## Further Notes

- All receipts in this spec were measured 2026-09-09 on tip 6d225ca2, this
  box, by the executor (commands and counts in the map's Context section) —
  the D3 discipline: no red believed or dismissed on a child's word alone.
- The confirm-gate record (execution order) lives in the map's `## Tickets`
  section once the user confirms.
- Arc numbering: 18 claimed at seed time; per arc-17 D1's lesson, expect
  renumbering at rebase if a parallel session merges an 18 first.
