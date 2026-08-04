type: research
status: closed
claimed: chart-session (2026-08-04)
blocked by: —

## Question

Do `scripts/stale-branches.sh` and `scripts/sweep-merged-branches.sh` have callers
beyond `scripts/pr-finish.sh`? If `pr-finish.sh` is deleted, do they become dead code
that this effort should also retire?

## Resolution

**No code callers; leave them in place (out of scope). The skill uses `sweep_branches`
for its report step.**

Repo-wide grep (`*.sh *.ts *.mjs *.md *.json`, excluding `node_modules` / `.planning/`
/ `dist` / `bun.lock`) shows **zero code callers** of either script. The only
references are:

1. `scripts/pr-finish.sh` **step 5** calls `stale-branches.sh` (report-only, expects
   "0 stale").
2. **Vault knowledge-graph notes** (`vaults_root/pi-agent-vault/Zettelkasten/knowledge-graph/`)
   documenting the *human* merge SOP — e.g. `PR-Merge-Procedure-for-Multi-Worktree-Repo.md`
   step 6 "run `stale-branches.sh` (expect 0 stale)".

So when `pr-finish.sh` is deleted, `stale-branches.sh` loses its only code caller, but
it remains a human-SOP script (and `sweep_branches` is the intelligent, gh-confirmed
replacement the skill will use for verification/reporting).

**Decision**: do **not** delete the companion scripts (out of scope — lean). The
`land-pr` skill's post-merge verify/report step calls `sweep_branches`, not
`stale-branches.sh`. The vault SOP notes are documentation, not blockers; they can be
refreshed to point at the skill in a separate docs pass if desired.
