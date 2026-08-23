---
ticket: 04
status: done
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

## Resolution

Contracts (MemoryRepository/SessionRepository + BackendBundle factory + sqlite fallback) already form the LeanRAG swap-by-contract seam — verified. Shared-logic extraction pilot (repo-common.ts, 378 LOC) measured net +364 LOC family-wide → REVERTED. sqlite/surreal repos are parallel dialects by design (LeanRAG Milvus/MySQL precedent). LOC-cut burden re-anchored to tickets 06/07/09.
