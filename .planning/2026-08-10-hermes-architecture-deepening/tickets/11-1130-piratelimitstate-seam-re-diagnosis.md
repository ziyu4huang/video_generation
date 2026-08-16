---
type: research
status: closed
claimed:
blocked by: (none — independent)
---
# 11 — #1130 `__piRateLimitState` seam re-diagnosis

Root-cause-first. The standing theory ("unregistered extension" — pi-agent-ext-subagent) is STALE: it IS statically registered now, yet `test:seam` is still red — for a FRESH reason.

## Acceptance
- Re-diagnose from zero: reproduce, isolate the actual failure mode (do not anchor on the stale theory).
- Fix, or file a precise follow-up with the real root cause.

## Notes
- Opened from the 2026-08-16 simplify-&-robusten grilling round.

## Closed (2026-08-16)
- Re-diagnosis (PR #1510, fc6ef7ad): `test:seam` fully GREEN on main (8/0 seam, 12/0 contract); `__piRateLimitState` registered in pi-agent-core-interface seam-keys via #1490. Prior reds were pre-#1490 stale worktree bases. Zero code change; #1130 already closed. Warning: if reds reappear, rebase to ≥#1490 main before diagnosing.

