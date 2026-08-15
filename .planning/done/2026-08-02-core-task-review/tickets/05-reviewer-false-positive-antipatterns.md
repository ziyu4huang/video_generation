---
type: task
status: closed
blocked by:
findings: M2
resolved: 2026-08-12 — shipped in #1071 — reviewer false-positive anti-pattern regexes tightened (`\bno issues\b`, "improvements" wording)
---

# 05 — Reviewer false-positive anti-patterns (`\bissue\b`, `improvement|enhancement`)

## Problem

The reviewer's `bug`/`refactor` keyword sets are over-broad for *completion-summary prose*. A clean completion that says "no issues; added several enhancements" enqueues both as bug + refactor `/list` items. Six layered patches (strip/unwrap/cut/dangling/vocab/dedupe) each fix one observed misfire without addressing the root cause.

## Evidence

- `core-task/src/goal/reviewer.ts:97-98` `CLASS_PATTERNS`: bug branch matches `\bbug\b|\bissue\b|regression|broken`; refactor branch matches `…|could be improved|improvement|enhancement|consider adding|would be nice|nice to have`.
- The six reactive patches: `stripCodeSpans` (`:120-125`), `unwrapHardWrappedLines` (`:138-161`), `cutAtClauseBoundary` (`:175-186`), `DANGLING_END` (`:164`), `SKIP_LINE`/`REVIEWER_VOCAB` (`:101-104`), `normalizeObjective` dedupe (`:190-196`, applied `:217-219`).

## Approach

1. Add an **anti-pattern** layer (mirroring `SKIP_LINE`/`REVIEWER_VOCAB`) for completion-summary false friends: `\bno issues\b`, `\bnon-issue\b`, `\bwithout (any )?issues?\b`, and `(several|minor|small)? improvements?` when adjacent to "added"/"made". Lines matching an anti-pattern are not classified.
2. **Long-term (optional, note in ticket):** require a finding keyword **plus** a fix-shaped cue (imperative verb / "should" / "needs") rather than keyword-alone — the root cause of "improvement" firing in a retrospective sentence.

## Acceptance

- [ ] Anti-pattern layer added; the "no issues / added enhancements" completion enqueues 0 items (regression test).
- [ ] A genuine "TODO: fix the broken loader" finding still enqueues (no false negatives).
- [ ] Existing reviewer tests still pass.
