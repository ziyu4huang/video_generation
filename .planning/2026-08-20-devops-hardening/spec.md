# Spec — devops-hardening: correctness fixes, UX guards, CI-budget residuals, alignment

- **Effort**: `devops-hardening`
- **Date**: 2026-08-20
- **Status**: approved; Phase 1 implemented on branch `devops-hardening-phase1` (user approved 2026-08-20); Phases 2-4 queued with just-in-time plans
- **Structure**: 4 phases, 4 PRs (mirrors `pi-agent-optimization` sequencing)
- **Baseline**: `origin/main` @ `f002c04e7` (post #1744). This worktree was detached at
  `9b79dc0b6` during exploration; every fact below was re-verified against `origin/main`.

## Background

Self-reflection + history-memory review (2026-08-20) surfaced recurring devops-tool
failures with real incident evidence. Two root causes were confirmed by reading
`origin/main` source:

1. **`verify_merge_landed` scope false-positives.** `verify-merge-recipe.ts:363` matches
   scope entries with literal `startsWith` — prefix semantics — while every usage
   convention (memory, PR finish invocations) passes glob-style `bun-apps/<pkg>/**`.
   A trailing `/**` can never prefix-match a real path, so every file is reported
   out-of-scope and the verdict is CONTAMINATED on a clean merge. Observed on
   PRs #1737 and #1739 (treated as noise in the moment; root cause was "unknown"
   until this session).
2. **`sync_default_branch` preserve-flow fragility.** The preserve cycle
   (stash push → advance → stash pop) can fail twice across runs:
   (a) a pop that conflicts leaves unmerged index entries + conflict markers in the
   worktree with no loud warning (observed 2026-08-19: `.agents/memory/MEMORY.md`
   left `UU` + a kept stash `MEMORY.md pre-sync 2026-08-19`); (b) the NEXT sync's
   preserve `stash push` then dies with the cryptic `error: could not write index`
   (observed 2026-08-20, both worktrees). The recipe has no pre-flight for unmerged
   entries and no aftermath reporting for a conflicted pop beyond `restored: false`.

Additional confirmed-still-open items: pr-finish detached-HEAD commit stranding
(memory `devops-pr-finish-cli-flags-and-detached-commit-trap`), local_ci cross-run
machine contention (41 s → 8–9 min with two concurrent runs; no lock), obsidian
vault byte-baseline red on main (`main_health`), SKILL.md tool-name drift (30 old-name
occurrences remain after #1738's partial rename), and `cli loop status` reporting
`unparseable coverage output` for wayfind-coverage-floor (the reporting tool itself
is broken).

## Already done on main (excluded from scope)

- **Three-dot diff** in changed-packages: `base...head` merge-base semantics shipped
  (`changed-packages.ts:12,156`).
- **CLAUDE.md** DevOps section: rewritten to the #1738 final tool names.
- CLI file renames: `sync-default-branch-cli.ts`, `merge-pr-after-ci-cli.ts`,
  `prepare-feature-branch-cli.ts`, `sweep-merged-branches-cli.ts` — this spec uses
  the new names throughout.

## Phase 1 — Correctness fixes (highest priority; unblocks trusting verify_merge on later PRs)

### 1a. Scope matching semantics (`verify-merge-recipe.ts`)

Extract a pure, exported `matchesScope(path: string, entry: string): boolean` and
define entry semantics explicitly:

- `x/**` → directory prefix `x/` (any depth below `x/`)
- `x/*` → direct children of `x/` only (single segment)
- `x/` → directory prefix (same as `x/**`)
- `x` (no trailing slash, no wildcard) → exact path `x` OR directory prefix `x/`.
  This TIGHTENS current behavior: today `bun-apps/foo` prefix-matches
  `bun-apps/foo-bar/…` (false CLEAN risk); after the fix it must not.

No new dependencies — normalization + `startsWith`/segment comparison cover all
real usages. `outOfScope` computation switches to `matchesScope`.

**Regression tests** (unit, against the pure function + through the recipe where
cheap): `**` matches deep paths; `**` rejects pseudo-prefix siblings
(`bun-apps/foo/**` vs `bun-apps/foo-bar/x.ts`); exact entry matches the file and the
directory; bare entry no longer matches sibling directories; renamed paths
(rename notation already resolved earlier in the recipe) scope-check on the new path.

### 1b. sync preserve hardening (`sync-recipe.ts`)

- **Pre-flight**: before any preserve `stash push`, run `git ls-files -u`. If any
  unmerged entries exist → abort with new reason `unmerged_index`, listing the
  paths and actionable recovery (resolve + `git add <path>`, or `git merge --abort`
  / `git rebase --abort` if an operation is actually in progress, or manually
  complete the stash pop). Never attempt a stash against a conflicted index.
- **Pop-conflict aftermath**: when the preserve `stash pop` conflicts
  (`restored: false`), the outcome gains a loud `warnings[]` entry plus a
  `preserveConflict` detail block: conflicted path(s), the kept stash ref, and the
  exact manual commands to finish the pop. Exit code stays 0 when the advance
  itself succeeded — but the warning must be impossible to miss in CLI output.

**Tests**: temp-repo fixtures covering (a) unmerged index → `unmerged_index` abort,
zero stash attempts; (b) pop conflict → advance still succeeds, warning +
`preserveConflict` present, stash retained.

### Phase 1 PR

`fix(devops): verify_merge_landed scope semantics + sync unmerged pre-flight/pop-conflict reporting`

## Phase 2 — pr-finish UX guards

- **Scope flag parsing**: `--expected-scope` (merge-pr-after-ci-cli) and `--scope`
  (verify-merge-cli) accept comma-separated values in addition to repeatable flags
  (shared argv helper). Usage errors print the message to stdout (with the JSON
  envelope) instead of empty stdout + exit 2.
- **Detached-HEAD stranding guard**:
  - `merge-pr-after-ci-cli` outcome gains a `nextStep` hint after detach:
    "create the next branch (`prepare-feature-branch-cli --branch X --create`)
    BEFORE committing — commits on the detached HEAD strand off-branch."
  - `prepare-feature-branch-cli --create` detects the stranded case — HEAD detached,
    commits on HEAD not contained by any branch (`git branch --contains HEAD`
    empty / HEAD not on base) — and warns with the reflog recovery recipe
    (`git reflog` → `git reset --hard <sha>` on the new branch, push
    `--force-with-lease`). Warning only; never auto-recovers.

**Tests**: argv parsing (repeatable + comma + mixed); usage-error stdout content;
guard triggers on a fixture detached HEAD with a stray commit; guard silent in the
normal case.

### Phase 2 PR

`feat(devops): multi-value scope flags + detached-HEAD stranding guards`

## Phase 3 — local_ci budget residuals

- **Cross-run lock**: local_ci (ci-recipe) serializes concurrent runs via a lockfile
  at a gitignored repo path (content: pid + timestamp; `O_EXCL` create; staleness
  detection — dead pid or age > threshold ⇒ reclaim; always removed on exit,
  including error paths). While waiting, report holder pid + waited duration in the
  outcome. Two concurrent full runs must complete in ≈ 2× single-run wall clock
  (≈ 82 s), not 8–9 min.
- **obsidian vault byte-baseline**: investigate the drift nature first (baseline stale
  vs submodule pointer moved); then regen the baseline via the existing tooling or
  re-point the recorded baseline. Acceptance: `main_health` (embed worktree) reports
  that gate green.

**Tests**: lock unit tests (acquire/wait/stale-reclaim/release-on-error) with
injected clock; baseline verification per the obsidian package's existing
baseline-contract test conventions.

### Phase 3 PR

`fix(devops): local_ci cross-run lock + obsidian vault baseline green`

## Phase 4 — Alignment + loop tooling

- **SKILL.md residual old names**: 30 occurrences of pre-#1738 names remain
  (`sync_repo`, `prepare_branch`, `await_pr_merge`, `verify_merge`, `pr_status`,
  `sweep_branches`, `main_health`, `local_ci`, `devops_retrospect`, `pi_deploy`,
  `pi_verify`) mixed with 20 new-name occurrences. Rewrite to the final names;
  keep one explicit note that legacy ids remain valid first keywords (wayfinder
  transcript compat) so the history is discoverable, referencing the append-only
  `extension-naming.md`.
- **`cli loop status` coverage parser fix**: the wayfind-coverage-floor row reports
  `unparseable coverage output` — locate the parser (pi-agent cli loop command),
  fix it against the current coverage output format, and pin the format with a test
  fixture so format drift fails loudly next time.

**Tests**: SKILL.md name-consistency test (grep-based tripwire asserting no
pre-#1738 bare tool names outside the legacy-keyword note — mirrors the
`tests/lint-executor-coverage.test.ts` tripwire pattern); loop parser unit test
with a captured-real-format fixture.

### Phase 4 PR

`fix(devops+pi-agent): SKILL.md final tool names + loop status coverage parser`

## Cross-phase acceptance gates (every PR)

1. `bun run test` in `bun-apps/pi-agent-ext-devops` (canonical script, includes build
   if defined) — plus `bun-apps/pi-agent` when Phase 4 touches it.
2. Cross-package typecheck green (local_ci gate).
3. New behavior carries unit tests; no regression in existing devops suites.
4. local_ci wall clock < 5 min (house budget).
5. PR chain per devops SOP: `prepare_feature_branch` → `run_local_ci` →
   `merge_pr_after_local_ci` → `verify_merge_landed` with `--expected-scope
   bun-apps/pi-agent-ext-devops/` (Phase 4 adds `bun-apps/pi-agent/` + SKILL path;
   spec/planning files in `.planning/` ride along per the standing rule).
6. Phase 1 ships FIRST — its verify_merge fix is what makes the later phases'
   CONTAMINATED/CLEAN verdicts trustworthy.

## Out of scope

- Subagent dispatch death-rate 24.5% (#1681) — subagent infra, not devops; tracked
  separately.
- Remote CI re-enable, deploy-mode work (Phase 1a/1b of the deploy effort shipped
  in #1740/#1742).
- Any change to preserve semantics beyond diagnostics (no auto-resolution of pop
  conflicts — advisory only).
- SKILL.md restructuring beyond name alignment.

## Risks / notes

- Scope-matching tightening (bare entry no longer matches sibling dirs) could
  flip some existing invocation from CLEAN to CONTAMINATED if a caller relied on
  loose prefix semantics — grep for `--expected-scope`/`--scope` call sites
  (memory + skill docs) before merging; all known call sites pass glob-style or
  dir paths, which are unaffected or strictly improved.
- Lockfile staleness heuristics can never be perfect (pid reuse); conservative
  thresholds + holder metadata in the outcome keep it debuggable.
- obsidian baseline: if the submodule pointer legitimately moved, "fixing" means
  committing a new gitlink, not regenerating bytes — the investigation step decides.
