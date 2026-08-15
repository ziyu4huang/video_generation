---
type: task
status: closed
blocked by:
findings: L3, L14, L15
resolved: 2026-08-12 — shipped in #1068 — `replay.ts` + test deleted; provenance fixed; typo fixed
---

# 13 — Dead-code + provenance cleanup (`replay.ts`, provenance line, test typo)

## Problem

Three low-risk cleanups: (L3) `todo/state/replay.ts` + its test are **dead code** that directly contradicts the "Session-only todos — never replayed" ubiquitous-language term (a maintainer could wire it back in); (L14) CONTEXT.md provenance says "Extracted from power-tool" while code says "ported from @narumitw/pi-goal v0.11.0"; (L15) a test-comment typo `writeReportReport`.

## Evidence

- L3 — `core-task/src/todo/state/replay.ts` (`replayFromBranch`); only importer is its own test (`src/__tests__/replay.test.ts:10`); `extensions/core-task.ts` never imports it (session handlers call `replaceState(EMPTY_STATE)` only). Contradicts `CONTEXT.md:43-45` ("never replayed").
- L14 — `CONTEXT.md:7` ("Extracted from power-tool") vs `goal.ts:2,4` + `commands.ts:11` ("ported from @narumitw/pi-goal v0.11.0", "adapted for power-tool embedding").
- L15 — `src/goal/__tests__/reviewer.test.ts:140` comment `writeReportReport` (real export is `writeReviewReport`).

## Approach

1. **Delete** `src/todo/state/replay.ts` + `src/__tests__/replay.test.ts` (prefer deletion over a retain-comment — they contradict an architecture decision). Confirm no importer remains.
2. Reword `CONTEXT.md:7` provenance to match code.
3. Fix the test-comment typo.

## Acceptance

- [ ] `replay.ts` + its test gone; `bun test` green; grep confirms no dangling import.
- [ ] CONTEXT.md provenance matches code.
- [ ] Typo fixed.
