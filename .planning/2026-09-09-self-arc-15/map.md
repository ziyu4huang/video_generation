---
effort: 2026-09-09-self-arc-15
created: 2026-09-09
last: 2026-09-09
status: done
# (reconciled 2026-09-09 by self-arc-17 close-out: shipped as PR #2232 (complex benchmark variants, matrix 8/8))
---

# Wayfinder map: 2026-09-09-self-arc-15 — merge-chain UX hardening (devops variant of the self-develop arc)

## Destination

The merge chain's failure surface is contract-tested and its two most expensive
rough edges are gone: (1) every abort reason is enumerated in an exported tuple
with a bidirectional drift guard and pinned exit codes, and (2) a docs-only
`.agents/` chore PR computes an empty package matrix instead of running all 29
packages. Then the remaining MC tickets (credential preflight, failure logs to
disk, cross-worktree rebase, post-merge visibility, worktree doctor) land
ticket-by-ticket with the same contract net.

## Context

- Evidence base: `.planning/plans/2026-09-07-devops-merge-chain-ux.md` — a
  GLM-5.3(pro) planning agent's ticket-level plan (MC-1..MC-7), grounded in the
  2026-09-07 merge-chain incidents (missing DEEPSEEK_API_KEY → 9 opaque e2e
  failures 2 min in; truncated abort output forcing manual gate re-runs; the
  vgpu-labs-demo cross-worktree rebase refusal; #2185's 8-minute docs-only PR).
- This arc is the VARIANT of the self-develop series: same
  plan→tickets→gates→PR discipline, applied to the devops tooling itself
  (previous arcs targeted the subagent/ultracode and archify surfaces).
- Sequencing follows the plan's own dependency edge: MC-7 (contract) FIRST so
  MC-1/MC-2 can extend the abort surface safely; MC-4 rides along (independent
  one-liner).

## Shipped

- **t01 = MC-7 (this PR)**: `PR_FINISH_ABORT_REASONS` exported
  (10 reasons); bidirectional drift guard — the set of `abort("…")` literals in
  the source EQUALS the tuple; table edges pinned (usage → 2, dry-run → 0,
  pr-status-failed e2e → 1).
- **t02 = MC-4 (this PR)**: `MATRIX_IRRELEVANT_PREFIXES` gains `.agents/`
  (read-in-session docs; structural gates unaffected); three tests pin
  zero-map, mixed, and fail-open shapes. #2185's 8-minute docs-only tax is gone.

## Tickets

- [x] `tickets/01-mc7-exit-code-contract.md`
- [x] `tickets/02-mc4-docs-only-fast-path.md`
- [ ] `tickets/03-mc1-e2e-credential-preflight.md` — abort BEFORE local CI when
  neither DEEPSEEK_API_KEY nor ZAI_API_KEY resolves (env + rc grep mirroring
  check-deploy-e2e.sh), actionable message naming the export lines; new reason
  `e2e-credentials-missing` rides the MC-7 table
- [ ] `tickets/04-mc2-failure-logs-to-disk.md` — full failing-gate output →
  `<repoRoot>/output/ci-logs/<label>-<ts>/`, path in the abort JSON
  (`ciLogDir`); inline 40-line detail shape UNCHANGED
- [ ] `tickets/05-mc3-via-temp-branch.md` — `prepare-feature-branch
  --via-temp-branch --pr <n>`: guarded detached-copy rebase for branches held
  by another worktree (the 2026-09-07 vgpu-labs-demo workaround, first-class)
- [ ] `tickets/06-mc5-mc6-visibility.md` — post-merge held-elsewhere structured
  outcome + worktree-doctor prune CLI

## Fog of war

- MC-1 severity: hard-abort (recommended) vs warning; whether rc-grep ports for
  both keys or ambient-only.
- MC-2 log retention (forever vs last-N).
- MC-3 conflict residue: keep the temp worktree on conflict for manual
  resolution (recommended).

## Back-links
Collision-note + back-link: this effort's arc number (15) collided same-day with the verify arc (wayfind + superpowers), which renumbered to 16 at rebase and merged as #2226 — see `.planning/2026-09-09-self-arc-16/map.md`. No content overlap (merge-chain UX vs skills verification).
