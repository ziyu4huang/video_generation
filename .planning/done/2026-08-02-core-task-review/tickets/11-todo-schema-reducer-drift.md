---
type: task
status: closed
blocked by:
findings: M7, L11
resolved: 2026-08-12 — shipped in #1065 — action-conditional schema + explicit reducer errors
---

# 11 — Todo schema/reducer drift (`blockedBy`/`status` on the wrong action silently no-op)

## Problem

The tool schema accepts `blockedBy` and `status` on **all** actions, but the reducer honors them on only one. A model issuing `todo {action:"update", id:1, blockedBy:[2]}` gets a misleading "update requires at least one mutable field" error (it *did* pass a field — just one `update` ignores). `status` on `create` is silently forced to `pending` (L11).

## Evidence

- Schema: `core-task/src/todo/tool/types.ts:90` (`status` Optional, all actions), `:95` (`blockedBy` Optional, all actions; description says "create only").
- Reducer `update` reads only `addBlockedBy`/`removeBlockedBy` (`state-reducer.ts:87-105`); `create` hardcodes `status:"pending"` (`:44`). `addBlockedBy`/`removeBlockedBy`/`includeDeleted` similarly accepted-but-honored-on-one.

## Approach

Pick one per field:
- **`blockedBy` on `update`:** either honor it as a full-replace (in addition to add/remove), or make the schema action-conditional and reject it with an explicit error.
- **`status` on `create`:** either reject it explicitly, or document the per-action field matrix in the schema descriptions.

Recommend: make the schema action-conditional (omit `blockedBy`/`status` where not honored) AND have the reducer reject mismatched action/field combos with a clear error — defense in depth.

## Acceptance

- [ ] `todo {action:"update", id:1, blockedBy:[2]}` either sets the deps or returns a clear "use addBlockedBy/removeBlockedBy on update" error (not the misleading mutable-field one).
- [ ] `status` on `create` rejected or documented; no silent forced-pending.
- [ ] Schema descriptions list the per-action field matrix.
