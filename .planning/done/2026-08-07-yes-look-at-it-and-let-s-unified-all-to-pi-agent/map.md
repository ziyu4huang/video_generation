---
effort: 2026-08-07-yes-look-at-it-and-let-s-unified-all-to-pi-agent
created: 2026-08-07
last: 2026-08-07
status: complete
---

# Wayfinder map: 2026-08-07-yes-look-at-it-and-let-s-unified-all-to-pi-agent

## Destination

**Sharpened 2026-08-07:** Improve `pi-agent-ext-devops`' gh/local-CI tooling — the GitHub-operations + merge/verify workflow. `pi-agent-ext-deploy` (artifact build/verify) stays a SEPARATE package and is OUT OF SCOPE: recon proved the two are distinct domains (zero shared deps / zero cross-imports / zero shared concepts), and deploy isn't part of the "gh devops + local CI" goal.

_Original intent (verbatim, prior session): "unify all into pi-agent-ext-devops, remove them after." Sharpened AWAY from unification after the domain verdict._

## Notes

- Global standing merge-workflow rule now lives in `~/.pi/agent/AGENTS.md`: never wait for remote CI → self-verify locally → `gh ship` (== `gh pr merge --squash`) → never `--auto`.
- `gh ship` alias created (user-global): `gh alias set ship 'pr merge --squash'`.
- Remote GitHub Actions DISABLED via PR #1045 (`.github/workflows/ci.yml` → `ci.yml.disabled`); branch protection on `main` removed (HTTP 404).
- Branch `feature/subagents-tui-realtime-log` rebased onto `origin/main`: 2 ahead / 0 behind (commits `7966129f` popup-hardening, `38fe1372` launcher-removal); not pushed.
- Existing devops tools today: `await_pr_merge`, `pr_status`, `sweep_branches`.

## Decisions so far

- **Keep devops and deploy as separate packages** — do NOT unify deploy into devops. Distinct domains (gh PR-ops vs artifact build), zero coupling; deploy isn't part of the gh/local-CI goal. _[decided 2026-08-07 via grilling]_
- **`await_pr_merge` repurposed to gate on local CI (composable)** — do NOT deprecate. Today it merges un-gated (CI disabled = no checks = "green"). Restore a gate, local not remote: merge only when `local_ci` (ticket 02) passes. Shape is composable — `local_ci` is a standalone reusable tool; `await_pr_merge` calls it and merges only if green. Drops remote-check polling/`--auto`; BEHIND force-push-to-rerun-CI no longer justified. Also resolves the "gh ship as a pi tool" fog (the merge tool IS the tool equivalent of the alias). _[decided 2026-08-07, ticket 01]_
- **No release concept (ticket 03)**: private/live-source packages mean versions are never consumed → no tags / releases / version-bumps. `main` + PRs is the delivery mechanism. deploy owns artifacts (pi_deploy); devops owns gh PR-ops; neither owns release.
- [05 — await_pr_merge: validate rebase target](tickets/05-await-pr-merge-validate-rebase-target.md) — RESOLVED-BY-04 (#1054): rebase/force-push path removed; BEHIND blocks; hazard moot.
- [06 — sweep_branches: check delete exit codes](tickets/06-sweep-branches-check-delete-exit-codes.md) — FIXED (#1055): delete methods throw on non-zero; failures routed to skipped[]; deleted* now truthful.

## Not yet specified

- ~~Whether `gh ship` should also be a pi tool~~ — RESOLVED via ticket 01 (the repurposed merge tool is the pi-tool equivalent of `gh ship`).
- "Improve devops" scope still open: PR & commit conventions (PR body template, conventional-commit enforcement, auto-link issues) and branch-hygiene automation (auto-delete merged branches, stale-branch detection) — surfaced in breadth-first grilling but not selected; remain fog.
- (Release/publish tooling graduated to ticket 03.)

## Out of scope

- `pi-agent-ext-deploy` (artifact build/verify) — separate package, untouched.
- The popup-menu hardening (`7966129f`) and status-launcher removal (`38fe1372`) — already done.
- Re-enabling remote CI / restoring branch protection — explicitly against the standing rule.
