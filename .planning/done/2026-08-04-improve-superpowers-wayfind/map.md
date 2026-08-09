---
effort: 2026-08-04-improve-superpowers-wayfind
created: 2026-08-04
last: 2026-08-09
status: complete
---

# Wayfinder map: 2026-08-04-improve-superpowers-wayfind

## Destination

A prioritized, decision-ticketed improvement backlog for the two pi-agent extensions worked this session — `pi-agent-ext-superpowers` and `pi-agent-ext-wayfind` — distilled from two parallel read-only surveys (15 candidates surfaced with file:line evidence). Reached: the highest-value decisions are resolved (bugs fixed at root, contract contradictions reconciled); two non-blocking backlog items remain.

## Notes

Two parallel read-only surveys ran on 2026-08-04, each surfacing ~6-10 candidates with `file:line` proof. The session's two already-fixed bugs (chartMap manifest #1024, action-only overlay #1025) were out of scope.

Skills every session consults: the wayfinder procedure (`procedures/wayfinder.md`); `systematic-debugging` + `test-driven-development` for the bug tickets.

## Decisions so far

- 01 to-tickets frontmatter → closed (PR #1029)
- 02 fog placeholder leak → closed (PR #1032)
- 06 effort date local/UTC divergence → closed (PR #1034)
- 04 dead unified-planning-dir.patch → closed (PR #1036)
- 03 .superpowers/sdd contract contradiction → closed (PR #1038, Option 1)
- 05 /wayfind dispatcher keyword collision → closed (PR #1039, Option 1)

## Completed follow-ups (non-ticket, verified merged)

- `tests/sdd-workspace.test.ts` CI coverage un-gated + stale ADR-0007 ref fixed — PR #1041 (commit 30db6de4, merged 2026-08-06). (Was the deferred "not yet specified" item that depended on ticket 03.)
- `task-brief` / `review-package` script headers updated off the stale `.superpowers/sdd/` default — folded into ticket 03's PR #1038.
- Quick wins: ADR `0006` collision renumbered (`0007-unconditional-artifact-home.md` created, `0005` cross-ref fixed); wayfind `README.md` refreshed (6 skills, `/wayfind done` + `/wayfind validate` in Commands table, test count 263); `fact-freshness-guard-design.md` base = `origin/<default>` via `symbolic-ref` (fallback `origin/main`).

## Backlog (deferred, non-blocking)

- superpowers `tests/bootstrap.test.ts` locks 44 injected-prose substrings — brittle coupling to wording. Medium refactor (extract a structured payload). Not blocking.
- wayfind `/wayfind done` spawns `scripts/tidy-next-goals.sh` via a **relative** path (`spawnSync(..., { cwd: ctx.cwd })`) — silently breaks when cwd is a subdir, and is a host-only no-op outside this repo (contradicts the package's "no shell scripts" posture). Port to TS or notify on failure. Not blocking.

## Out of scope

- The session's fixed bugs: chartMap manifest (#1024) + action-only overlay (#1025). Closed.
