> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-08-04-scripts-pr-finish-sh-i-want-this-script-hardenin

## Destination

A `land-pr` **agentic skill** in `pi-agent-ext-devops/skills/` that orchestrates the
extension's existing tested tools (`await_pr_merge` / `pr_status` / `sweep_branches`)
plus plain `git`, and encodes the **judgment neither the bash script nor the tools
have**: diagnose a flaky / package-unrelated CI failure → decide rerun-vs-abort;
run the multi-worktree post-merge cleanup (sync `main` in the primary worktree,
detach the feature worktree, delete the branch); escalate to the human on a *real*
BLOCKED (missing review / genuine failure) rather than loop or false-abort. Once
the skill proves it lands PRs reliably, **delete `scripts/pr-finish.sh`**. Lean:
no new tooling unless a ticket proves it necessary; reuse the 91 tested devops tools.

## Notes

- **Domain**: `bun-apps/pi-agent-ext-devops/` (extension) + `scripts/pr-finish.sh`
  (the 11-iteration bash being retired). Architecture: `src/` = pure decision logic
  (`pr-logic.ts`, `branch-logic.ts`) + I/O recipes (`recipe.ts`, `branch-recipe.ts`)
  + `gh.ts` (`Bun.spawn` adapter); `extensions/devops.ts` = thin tool glue. See its
  README.
- **Skills every session consults**: `grilling`, `domain-modeling` (wayfinder).
- **Standing preferences**: *"agentic skill over fixed script without intelligence"*
  (user). Lean — reuse the existing tools; add code only if a ticket proves it's
  needed. Match the repo's multi-worktree reality (≈13 worktrees; `main` lives only
  in the primary worktree).
- **Why this isn't a port**: devops already ships the deterministic mechanics
  (`await_pr_merge` ≈ pr-finish steps 2–3; `sweep_branches` ≈ step 4). The prize is
  the **judgment layer** on top — the thing a fixed script structurally cannot do.

## Decisions so far

<!-- the index — one line per closed ticket: gist + link -->

- [Skill discovery = bare package skills](tickets/01-skill-discovery-mechanism.md) — `skills/land-pr/SKILL.md` + `package.json` `skills`/`files` keys; no superpowers-style session-start bootstrap (land-pr is on-demand).
- [Companion scripts have no code callers](tickets/02-companion-script-callers.md) — `stale-branches.sh` / `sweep-merged-branches.sh` left in place (out of scope); the skill uses `sweep_branches` for its report step.
- [Flake-judgment = rubric + escape hatch](tickets/03-flake-judgment-design.md) — untouched-by-diff → rerun once; touched / monorepo / unmappable + any 2nd failure → surface (name + `state` + duration + diff-relevance verdict + ready command, then stop).
- [Flake-diagnosis data = raw `gh pr checks` is enough](tickets/05-flake-diagnosis-data-source.md) — `--json name,state,startedAt,completedAt,workflow` covers the rubric (`state` is the conclusion-equivalent); no `pr_status` enrichment, no new tooling — stays lean.
- [Post-merge cleanup = worktree-aware 4-step](tickets/04-worktree-postmerge-cleanup.md) — detect layout → sync `main` in primary (`git -C`) → retire feature worktree (`fetch --prune` + `checkout --detach origin/main` + `branch -D`) → verify via `sweep_branches`; draft accepted, folds into the skill at build time.
- [Proof & removal bar = dogfood + targeted tests](tickets/06-proof-and-removal-bar.md) — delete `pr-finish.sh` after the skill lands ~3 real PRs end-to-end (incl. ≥1 flake-rerun; #1023 is the candidate) without fallback + unit tests for the deterministic logic (rubric decision fn + worktree-cleanup sequence); escape-hatch / live-flake stay dogfood-only.

## Not yet specified

<!-- fog: in-scope but not sharp enough to ticket yet; graduates as the frontier advances -->

- Whether `land-pr` is the seed of a broader **devops skill set** (e.g. a future
  `release` / `rollback` skill) that would want a session-start orientation
  bootstrap. Graduates only if a second devops skill arrives.
- Empirical confirmation that **bare package skills load from an extension
  package** (vs needing explicit `resources_discover` registration). Couples to
  the build; verify with `/skill:land-pr` then.

## Out of scope

<!-- ruled beyond the destination; closed, never graduates -->

- Retiring `stale-branches.sh` / `sweep-merged-branches.sh` — lean scope is just
  `pr-finish.sh`; #02 confirmed they have no code callers, so leaving them is
  harmless.
- Building new devops tooling (e.g. enriching `pr_status`) — **#05 proved it isn't
  needed** for #03's rubric; raw `gh pr checks` suffices.
- A superpowers-style `resources_discover` + session-start bootstrap (#01 decided
  the bare mechanism suffices for an on-demand skill).
- A full unit-test harness for the skill's *judgment* — proof is dogfood (lands
  real PRs); only the deterministic parts (worktree cleanup) earn a light test.
