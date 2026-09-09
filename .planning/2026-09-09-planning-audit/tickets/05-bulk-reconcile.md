# t05 — bulk reconciliation

Apply D5 to every remaining red row (~13 stale-active + 10 no-status + 7 odd
tokens + any terminal-without-provenance the tool finds). Hard constraints:
`2026-09-09-self-arc-17/` untouched (verify `git diff --stat origin/main --
.planning/2026-09-09-self-arc-17/` empty before opening the PR); no dir moves
into done/; every flip cites verified PR numbers or a dated reason; failing
rows are annotated, never deleted.

Acceptance: `results/reconciled/audit.{json,md}` committed; only remaining
reds are live-exempt rows + explicitly recorded gaps.
