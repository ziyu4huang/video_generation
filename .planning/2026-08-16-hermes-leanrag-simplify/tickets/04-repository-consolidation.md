---
ticket: 04
status: open
blocked-by: [01]
---

## Goal

Consolidate 4 repository implementations into 2 behind one contract per side: `MemoryRepository` + `SessionRepository` (sqlite + surreal impls).

## Scope

- Define the two repository contracts.
- Delete the 2 redundant variants (~1.9k LOC).
- Keep repo-contract test suites running against both surviving impls.

## Acceptance

- Repo-contract suites green for sqlite + surreal.
- LOC delta recorded.
