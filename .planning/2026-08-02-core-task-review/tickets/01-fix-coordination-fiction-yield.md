---
type: grilling
status: closed
blocked by:
findings: H1, M9
resolved: 2026-08-07 — option (b) DELETE: shipped in #1051 (ADR-0006); double-drive risk accepted as user-initiated
---

# 01 — Decide & implement the wayfind↔goal/loop mutual-yield (the coordination-fiction epic)

## Problem

The headline finding (see `../findings.md` §Executive): the *"peers read each other's seam to yield turn-ownership"* story is **false in code**. `__piWayfindActive` is published but consumed by nothing; `__piGoalActive` is read only intra-package (loop) + display-only (power-tool); the "yielding plan coordinator" described across wayfind's README/ADR/index.ts and core-task's own comments **does not exist** (`src/plan/*` is pure parse/cache/publish). Consequence: a live grill (auto-continues) and a `/goal`/`/loop` can **double-drive** one session.

## Evidence

- Published, never consumed: `bun-apps/pi-agent-ext-wayfind/src/coordination.ts:21` (publisher) + `:46` (self-check only). Repo grep for the key in `bun-apps/**/src` = 0 consumers.
- Neither gate checks it: `startGoal` (`core-task/src/goal/goal.ts:964`, checks only `isLoopActive()`); `/loop start` (`core-task/src/loop/loop.ts:272`, checks only `__piGoalActive`).
- Stale doc sites (~6): `wayfind/src/index.ts:55`, `wayfind/README.md:56` (refs nonexistent `isExternalDriverActive()`), `wayfind/docs/adr/0004:80`, `core-task/src/goal/goal.ts:170-176`, `core-task/extensions/core-task.ts:44`, `CONTEXT.md:7,40` (`__piGoalActive` "read by the plan coordinator and wayfind" — wrong; M9).

## Decision to make first

**Implement or delete?**
- **(a) Implement the yield** — gate `startGoal` / `/loop start` / continuation on `globalThis.__piWayfindActive?.() ?? false` (mirror the existing `__piGoalActive` reader idiom: `typeof === "function" ? fn() : false`). This makes the documented contract real.
- **(b) Delete the seam** — `unpublishWayfindActive`'s publish path, drop `__piWayfindActive` from `SEAM_KEYS` (`bun-apps/tests/seam-contract.test.ts:58`), and correct the ~6 doc sites to "wayfind does not yield; mutual-exclusion is user-initiated."

Either way: **correct the `__piGoalActive` prose (M9)** to "read by the in-package loop subsystem (mutual exclusion) + surfaced by power-tool's inspect-tui."

## Acceptance

- [ ] Direction chosen (a or b) and recorded as an ADR under `bun-apps/pi-agent-ext-core-task/docs/adr/` (or wayfind's, if the decision is wayfind-owned).
- [ ] Code matches the decision (gate implemented, or seam + publish removed).
- [ ] All ~6 stale doc/comment sites corrected to match reality (incl. M9 `__piGoalActive` prose).
- [ ] No double-drive: a test asserting that with a grill active, `/goal`/`/loop` start is refused (if a), or that no code references the removed key (if b).

## Notes

- Gates ticket **02** (the contract-test hardening must reflect whichever contract this lands on).
- The existing `2026-07-19-a` effort already concluded the plan-coordinator-yield was "N/A" (see that effort's ticket 04) — read it before deciding; the double-drive risk is the new information that may flip that call.
