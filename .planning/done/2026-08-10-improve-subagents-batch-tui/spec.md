> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
> SUPERSEDED by RunView phase-2 (#1347/#1351/#1352) — buildLiveTable now renders RunView[].
# Improve `subagents` batch TUI — design spec

**Date:** 2026-08-10
**Status:** Approved (brainstorming) → ready for implementation plan
**Effort:** `.planning/2026-08-10-improve-subagents-batch-tui/`
**Scope:** `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (render layer) + a local running-usage accumulator in `execute()`.

## Problem

The batch `subagents` tool card shows far less information than the single `subagent` card, even when expanded (ctrl-o):

- **Running (live):** a single line — `subagents · N/M running · latest: <one action>`. No per-child visibility.
- **Done collapsed:** per slot shows `badge · model · elapsed · task` but **omits cost/tokens** even though `BatchResultSlot.usage` carries them.
- **Done expanded:** per slot shows only `### [i] status` + raw output — **no model/elapsed/cost/tokens**, none of the single card's meta.

By contrast the single `subagent` card renders `✓ done · model · 34.5s · $0.000 · 15715 tok` (+ SDD/scope/budget tags).

## Root cause

Predominantly a **render-choice** gap, not a data gap. `BatchResultSlot` (`subagents-tool.ts:41-85`) already captures `model`, `requestedModel`, `fellBack`, `elapsedMs`, `task`, `status`, and `usage` (cost+tokens). `renderSubagentsResult()` does not build the per-child meta string that `renderSubagentResult()` does.

The single card's SDD-report / commit-scope / watchdog tags are **N/A** for batch children (read-only: edit/write/bash always excluded → no commits, no SDD implementer status, no edits to review).

## Goal

Every child in the batch card shows the same meta the single `subagent` card does, in all three render states: running (live), done collapsed, done expanded.

## Design

### Render targets

| State | Header | Per-child row |
|---|---|---|
| Running (live) | `subagents · N/M running · Σtok · $Σ` | `[i] (id) slot ⏱/✓ liveElapsed · currentAction` |
| Done collapsed | `batch (X ok · Y failed · Z skipped) — Ts · $Σ · Σtok` | `[i] (id) ✓ model · elapsed · $cost · Ntok · "task"` |
| Done expanded | same header | `### [i] (id) status` + meta line `model · elapsed · $cost · Ntok` + output |

- `slot` = `tier:small` / capability / resolved model (the requested slot; resolved model shown on fallback like the single card).
- `currentAction` from the existing `summarizeLatestAction(history)`.
- `Σtok`/`$Σ` = sum over children's usage.

### Components (all in `subagents-tool.ts` unless noted)

1. **`formatUsage(u)`** — returns ` · $X.XXX · Ntok` when `u && u.total > 0`, else `""`. Mirrors the single card.
2. **`formatSlotMeta(slot, theme)`** — `model · elapsed · usage`, with fallback-model handling (`requested → resolved`). Shared by collapsed + expanded (DRY).
3. **Rewrite `renderSubagentsResult`**:
   - Header: add aggregate ` · $Σ · Σtok` (sum of `slot.usage`); keep elapsed.
   - Collapsed: per-slot line uses `formatSlotMeta`.
   - Expanded: prepend a `formatSlotMeta` line above each child's output. Preserve existing null/budget/aborted slot handling (add meta only where the slot variant carries the fields).
4. **`buildLiveTable(entries, theme)`** *(new pure fn)* — one row per in-flight child (filtered by `batchId`): `[i] (id) slot ⏱/✓ liveElapsed · currentAction`. Sorted by dispatch index. Pure → unit-testable without dispatching.
5. **Rewrite the `onUpdate` text** in `dispatchChild`'s `onHistory` callback — header (counts + aggregate usage) + `buildLiveTable(...)`. Multi-line; collapsed shows the header line, ctrl-o shows the full table (same expand model as the done view via the existing `isPartial` branch).
6. **Local `runningUsage: Map<runId, AgentUsage>`** in `execute()` + wire `onUsage` on `childSpawnOpts` → feeds the running header's Σtok/$Σ. *(The only non-render change; the rest reads already-captured data.)*

### Data flow

- **Done:** `BatchResultSlot.{model,requestedModel,fellBack,elapsedMs,usage,status,task}` → `formatSlotMeta`. No new plumbing.
- **Running:** `options.inFlight.list()` filtered by `batchId` → `buildLiveTable`; aggregate from the local `runningUsage` map (updated via `onUsage`).

## Error handling

- All builders defensive: missing fields degrade (skip/empty string), never throw. `onUpdate` stays try/caught (diagnostic only).
- `buildLiveTable`: empty in-flight list → header only.
- Null (failed) / budget / aborted slots preserved as today; meta added only where the variant carries the fields.

## Testing

- Unit (pure fns): `formatUsage`, `formatSlotMeta`, `buildLiveTable`.
- Unit: `renderSubagentsResult` collapsed + expanded across slot variants: done / failed(null) / budget / aborted × {with,without usage} × {with,without id} × {fallback, no fallback}.
- Update any existing format snapshots; keep all current subagent/subagents tests green.

## Out of scope

- SDD-report / commit-scope / watchdog tags (N/A for read-only batch children).
- A3 large-fan-out truncation (deferred; revisit if fan-out >6 becomes common).
- Single `subagent` card (unchanged — already good).

## Open questions

None at design time. The implementation plan will sequence the 6 components + tests.
