---
type: task
status: closed
blocked by:
findings: H3, L2
resolved: 2026-08-12 — shipped in #1063 — `/goal review on|off|auto|aggressive` parse; `/glla` removed; reviewer mode settable
---

# 03 — Reviewer config surface: rewrite `/glla` strings + expose `mode` + test auto/aggressive

## Problem

`reviewer.ts` emits 5 user-facing suppression-reason strings that point at `/glla postaudit` — a GLA command that **does not exist** in core-task. Today they're latent (`goal.ts:400` discards `suppressedReason`), but the spec itself (`docs/2026-07-31-reviewer-spec.md:287-291`) flags them as a landmine. Worse, the only real toggle is `/goal review on|off` (flips `enabled` only) — `mode`/`fireOn`/`maxReviewsPerDay` are **un-settable**, so the refire-window/day-cap reasons have no user lever even after a rewrite. The `auto`/`aggressive` cascade modes (L2) are reachable in code but unreachable from any command and untested.

## Evidence

- 5 strings: `core-task/src/goal/reviewer.ts:321,324,327,329,341`.
- Only toggle: `/goal review on|off` (`commands.ts:52,96`; wired `goal.ts:517-519`; state `state.ts:186-187`). Settings menu dropped (`reviewer.ts:14`).
- Untested cascade modes: `reviewer.ts:353-420` (`auto`/`aggressive`); only `on` is tested (`reviewer.test.ts:131`).

## Approach

1. Expose the reviewer mode via `/goal review on|off|auto|aggressive` (the cascade code for all four already exists — just unreachable). Map the arg to `reviewerConfig.mode` + persist.
2. Rewrite the 5 strings: enabled/mode cases → `"/goal review on"` / `"/goal review auto"`; drop the menu-pointer suffix for refire-window/day-cap (e.g. "…(runaway prevention)", "daily cap reached (N/M)").
3. Add `runReviewer` unit tests under `{mode:"auto"}` and `{mode:"aggressive"}` asserting no-Confirm enqueue + aggressive-relaunch outcomes; add a wiring test completing an `origin:"list"` goal through `goal_complete` (the `kind:"list"` path is also unexercised).

## Acceptance

- [ ] No `/glla` string remains in `reviewer.ts` (`grep -rn glla` → 0).
- [ ] `/goal review auto` actually sets the mode and the cascade behaves accordingly (test).
- [ ] `auto`/`aggressive` cascade branches covered by tests.
- [ ] The 5 rewritten strings read correctly in the contexts they can surface.
