---
type: skill-docs
blocking: none
status: open
---

# 03 Wayfind dispatch pointer blocks (spec M3)

## Question
Can wayfind's dispatch-mentioning skills emit survivable dispatches without
duplicating the recovery recipe?

## What to build
- In each of the 5 skills that mention subagent/dispatch (ask-matt, grilling,
  improve-codebase-architecture, to-spec, to-tickets): a <=10-line dispatch
  block that (a) points to superpowers:dispatch-recovery as the single source,
  (b) carries the sizing one-liner (turns >= steps + 2, verbatim-apply default,
  turn-1 mega-block).
- No full recipe duplication anywhere in wayfind.

## Acceptance
- grep shows the pointer block present in all 5 SKILL.md files.
- ( cd bun-apps/pi-agent-ext-wayfind && bun test ) green (513+).
- dispatch-recovery remains the only full-recipe text (grep check).
