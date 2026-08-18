---
type: code
blocking: none
status: open
---

# 02 Subagent maxTurns default (spec M2, authorized in grill D5)

## Question
Can unspecified dispatches stop dying at low turn caps by defaulting maxTurns,
without touching token ceilings or explicit caller values?

## What to build
- pi-agent-ext-subagent: budget-defaults.ts (or sibling) gains
  DEFAULT_MAX_TURNS = 12 + env override SUBAGENT_MAX_TURNS; wired so the
  subagent tool applies it ONLY when the caller omits maxTurns.
- Tests: (1) default applied when omitted; (2) env override respected;
  (3) explicit caller value untouched.
- Docs: README row for the new default + env var, matching existing
  budget-defaults documentation style.

## Acceptance
- ( cd bun-apps/pi-agent-ext-subagent && bun run test && bun run typecheck )
  green (test = check + build + test:unit).
- New tests present and passing; no behavior change for explicit maxTurns.
