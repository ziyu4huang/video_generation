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

## Closed (2026-08-16 — not reproducible on main)
- Re-diagnosis from zero: `test:seam` is GREEN on main (seam 8/0; contract trio 12/0). `__piRateLimitState` is registered (seam-keys.ts:29 ← rate-limiter.ts:34); the SEAM_KEY entry landed in #1490 (b78454f8).
- Root cause of observed reds: stale pre-#1490 worktree bases (token present, SEAM_KEY absent → NO ORPHANS fires). Issue #1130 is closed. The "unregistered extension" theory was doubly wrong: wrong axis (the seam test checks __pi* tokens vs the SEAM_KEY registry, not extension registration) and subagent is registered anyway (static-extensions.ts:64 + run-dir/manifest.json:74).
- No code fix on main. If a red reappears: first rebase onto ≥#1490 / fresh main before diagnosing.
