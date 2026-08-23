---
ticket: 10
status: done
blocked-by: [02, 03, 04, 05, 06, 07, 08, 09]
---

## Goal

Re-measure and hard-pin the schema-cost of ALL surviving tools.

## Scope

- Update the `schema-cost.regression` pin to the 6-tool surface.
- Budget ≤ 2100 tok (the 5-tool baseline 1550 / ≤1700 stays).

## Acceptance

- Regression test green at the new pin.
- Measurement report recorded in this ticket.

## Resolution

All 6 surviving tools hard-pinned (memory, search, knowledge_ingest, knowledge_search, skill_manage, skill_manage_help). Measured 2033 tok ≤ 2100 budget (SIX_TOOL_BASELINE recorded; comment: re-pin consciously, never silently). Knowledge tool descriptions trimmed −203 tok (params/enums untouched). vs ticket-01 baseline: 10 tools 3066 tok → 6 tools 2033 tok (−34% schema cost, −4 tools).
