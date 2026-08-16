---
ticket: 02
status: open
blocked-by: [01]
---

## Goal

Merge `memory_search` + `session_search` into one unified `search` tool with a mode param (`memory|session|knowledge`).

## Scope

- Implement the new unified tool with mode parameter.
- Update tool registration in `src/index.ts`.
- Adapt existing tests of both old tools to the unified surface.

## Acceptance

- The 2 old tools are demoted from the registered surface.
- Unified tool passes the adapted tests.
- `knowledge_search` remains untouched (ADR-pi-agent-0004).
