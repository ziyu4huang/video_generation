---
type: skill-docs
blocking: none
status: done
---

# 01 Superpowers skill slimming + discipline injection (spec M1)

## Question
Can the 4 over-bar SKILL.md files compress to <=300 lines each, intent-preserving,
while dispatch discipline gains a single-source sizing rule?

## What to build
- Compress: writing-skills 715, subagent-driven-development 503,
  systematic-debugging 333, test-driven-development 320 -> each <=300 lines.
  Rules kept, prose tightened, examples merged — no rule deleted, only
  compressed.
- dispatch-recovery (49 lines) gains the budget-before-dispatch sizing rule:
  turns >= task steps + 2; tokens by tier; verbatim-apply as default authoring
  mode; turn-1 mega-block. Stays <=300.
- SDD + executing-plans REFERENCE dispatch-recovery's sizing rule; no
  duplication.
- ADR-superpowers-0004 flow: edit -> bun scripts/rebaseline-upstream-skills.ts
  -> bun test; LOCAL-DIVERGENCES rows in UPSTREAM.ref as needed.

## Acceptance
- wc -l bun-apps/pi-agent-ext-superpowers/skills/*/SKILL.md -> max <=300.
- ( cd bun-apps/pi-agent-ext-superpowers && bun test ) green (144+).
- Rebaseline script ran clean; tests pass.

## Completion 2026-08-18
writing-skills 715->298, SDD 503->262 (wave A, commit 612a7d291); systematic-debugging + test-driven-development trimmed under 300 (wave B); dispatch-recovery +sizing rule; executing-plans +single-source reference. Rebaseline ran; 144 tests green; max skill line count 298 <= 300.
