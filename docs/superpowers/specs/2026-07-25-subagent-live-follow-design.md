# Design — pi-agent-ext-workflow: `/subagents` live-follow view (attach + stream a running subagent's trace)

**Date:** 2026-07-25
**Package:** `bun-apps/pi-agent-ext-workflow` (touches `pi-agent-ext-subagent` for one export)
**Status:** approved (brainstorming — Approach A, extend `SubagentViewer` with a `follow` view-mode)
**Git strategy:** fresh feature branch off `origin/main`

## Background

`#808` (`d9261582 feat(subagent): resolved model in TUI + always-on progress widget`) shipped
three of the four things this feature area needs, all already in `main`:

1. **Model-id choose logic** — `resolveAgentModelSpec` (`pi-agent-ext-subagent/src/agent.ts`):
   precedence `explicit model > tier (default medium) > session (mainModel)`. `spawnSubagent`
   threads the same path; `onModelResolved` surfaces the concrete `provider/id` mid-run.
2. **Config logic** — `~/.pi/workflows/model-tiers.json` (small/medium/big) edited via
   `/workflows-models`; `.pi/agents/*.md` bind per-`agentType` model/tier/tools/prompt.
3. **TUI shows model-id** — the `subagent` tool's `renderCall` (slot + `resolvedModel` segment),
   `renderResult` (`model · elapsed · usage`), the always-on `SubagentProgressWidget`, and the
   `/subagents` viewer all display the (shortened) model.

The **only genuine gap** is the fourth: a slash command that **attaches to a running subagent and
streams its tool-call trace in real time**. Today:

- The `≤100`-line live trace (`formatSubagentLive`) exists **only** on the tool's own call-line,
  surfaced via `Ctrl-O` (`app.tools.expand`) while that specific tool call is on screen.
- The `/subagents` "Running" section (`subagent-viewer.ts`) reads the shared
  `SubagentInFlightRegistry` live and ticks elapsed every second, but renders **only a one-line
  latest-action summary** (`summarizeLatestAction`) per running row — not a streaming log, and
  you cannot drill into a running subagent from there (enter only opens the **completed**-run
  output view).

So a long-running subagent dispatched in the background is invisible in any slash command until it
finishes, unless its tool call-line happens to still be on screen.

## Goal

- From `/subagents`, select a **running** subagent and enter a **live-follow view** that streams
  its tool-call trace (tool name + args preview, result `✓` + preview, errors, elapsed) as it
  works — a `tail -f`-style attach, reusing the same per-line format the inline `Ctrl-O` trace
  already uses.
- When the followed subagent **finishes**, the view **freezes in place** at its last state and
  shows the final status (`✓ done` / `✗ failed` / `⏱ timedout` / `⛔ budget`) + usage
  (cost/tokens); `esc` returns to the list, where the run now appears in the Completed section.
- One command, one viewer component, one mental model — extend the existing `SubagentViewer`,
  not a new command and not a parallel component.

## Non-goals

- A new dedicated slash command (`/subagent-log`). Considered as Approach B during brainstorming
  and rejected: `ui.custom` mounts one component per viewer session, so a separate command would
  need an internal list↔follow delegate shell — strictly more plumbing for no separation benefit.
- Changing the `subagent` tool's model-resolution precedence, the `model-tiers.json` config, or
  the `/workflows-models` command. Those are already complete post-`#808`; not touched here.
- Inline accordion expansion of a Running row in the list (Approach C) — rejected: mixes summary
  rows with expanded trace, awkward scrolling, worse UX for a focused live log.
- The always-on `SubagentProgressWidget` (`#808`) — unchanged; it continues to show the compact
  one-line-per-running summary below the editor. The follow view is the *drill-in* surface.

## Brainstorming decisions (locked)

| Decision | Choice |
|---|---|
| Command shape | **Extend `/subagents`** with a `follow` view-mode (not a new command). |
| View lifecycle on finish | **Freeze + show final status/usage** in place; `esc` → list. |
| Implementation approach | **A** — add a third `view` mode to `SubagentViewer`; reuse its timer + registry binding. |
| List interaction | **Unified selectable list** — `[running…] ++ [completed…]` as one flat cursor with a divider; `enter` dispatches by row kind. |
| Completion detection | **Registry-entry-absent** → resolve final status from a **live re-scan** of the session branch. The tool's `finally`→`inFlight.end()` teardown is **unchanged**. |
| Trace cadence | **1 s** (reuse the viewer's existing invalidate timer). Event-driven `<250 ms` invalidation deferred to v1.5. |
| Trace window | **`tail -f` last-N** (`FOLLOW_TRACE_LINES`, default 40), latest at the bottom. Manual scrollback deferred to v1.5. |

## Architecture

`SubagentViewer` (`pi-agent-ext-workflow/src/subagent-viewer.ts`) currently has two view modes.
We add a third:

```
                         enter on a Running row
   list  ────────────────────────────────────────▶  follow
    ▲ │                                                │
    │ │ enter on a Completed row (existing)            │ esc
    │ ▼                                                │
  output ◀── esc ── (existing)                         │
    └──────────────────────────────────────────────────┘
```

- **`list`** — Running rows become **selectable** (unified cursor; see Interaction).
- **`follow`** — attach to one running subagent, stream its trace; on completion **freezes
  in place** (status/usage banner), `esc` → list.

### Interaction model (unified selectable list)

The current Running section is **non-selectable** (the cursor only walks the Completed list). To
follow a running subagent the user must be able to target one. We merge both into one flat,
selectable list with a divider:

```
 ┌ Running ─────────────────────────
 │  ▶ #impl  ▸ gemma-4-12b-qat • running • 12.3s • 4 tools   ← selected
 │    #rev   ▸ gpt-4.1 • running • 3.1s • 1 tool
 ├ Subagent runs ───────────────────
 │    #1 implementer ▸ gemma-4-12b-qat • ✓ done • 48.2s • $0.012 • 9.2k tok
 │    #2 reviewer   ▸ gpt-4.1 • ✗ failed • 5.0s
 └
  ↑↓ select • enter view/follow • esc close
```

- `selected` indexes into a flat `entries` array rebuilt each list render:
  `Array<{kind:"running", ref: InFlightSubagent} | {kind:"completed", ref: SubagentRun}>`,
  clamped after rebuild (a running entry that disappears on completion shifts indices).
- `enter` dispatches by kind: `running` → `enterFollow(ref.id)`; `completed` → existing `output`.
- Alternative considered (number-key `1..9` direct-follow, leaving the Completed cursor
  untouched) rejected as less discoverable and clashing when many run concurrently.

## Components (4 changes, all in existing files)

### ① `SubagentViewer` — extend (`src/subagent-viewer.ts`)

- `view: "list" | "output"` → `"list" | "output" | "follow"`.
- New private fields:
  - `getRuns?: () => SubagentRun[]` — **live** re-scan of the branch, used only to resolve a
    followed run's completion (the list still uses the open-time `runs` snapshot — existing
    behavior preserved).
  - `followedId?: string` (the `toolCallId`).
  - `followedSnapshot?: { history: AgentHistoryEntry[]; model: string; agent?: string; taskPreview: string; startedAt: number }` — last live snapshot, retained so the freeze and the timing-window fallback always have something to show.
  - `followedFinal?: SubagentRun` — resolved completion (status/usage/output), set once.
  - `followEnded = false` — follow-view-local display flag, set when the grace window expires
    unresolved. **Not** a `SubagentRun.status` value (that union stays
    `done|failed|timedout|budget`); it only drives the neutral `ended` banner render.
  - `finalizingTicks = 0` — grace counter for the registry↔branch timing window.
- Unified list: build `entries` each list render; `selected` spans both sections and is clamped.
- `handleInput`:
  - `list`: `up`/`down` move `selected` across `entries`; `enter` → `running`:
    `enterFollow(ref.id)`, `completed`: `view = "output"` (existing).
  - `follow`: `esc` → `view = "list"` (clears follow state; re-select to follow again).
  - `output`: unchanged (`esc` → list).
- `enterFollow(id)`: `followedId = id; followedFinal = undefined; followEnded = false; finalizingTicks = 0; view = "follow"`.
- `renderFollow(width, theme)`:
  1. `r = getRunning()?.find(x => x.id === followedId)`.
  2. **`r` present → LIVE**: `followedSnapshot = { history: r.history ?? [], model:
     r.resolvedModel ?? r.model, agent: r.agent, taskPreview: r.taskPreview, startedAt:
     r.startedAt }`; `finalizingTicks = 0`; `status = "running"`.
  3. **`r` absent → COMPLETED resolve**:
     - If `!followedFinal && !followEnded`: try `final = getRuns?.().find(x => x.toolCallId ===
       followedId)`; on hit → `followedFinal = final`. On miss → `finalizingTicks++`; if it
       exceeds `FOLLOW_FINALIZE_GRACE_TICKS` → set `followEnded = true` (neutral `ended`
       banner; the view never hangs).
     - Derive `status`/`usage`/`output` from `followedFinal`; when `followEnded` is set with
       no `followedFinal`, render the neutral `ended` banner instead.
  4. Header: `▸ {shortModel(model)} • {status} • {elapsedS}s{usageStr}` prefixed by the agent
     label (`#agent` or `general-purpose`). `elapsedS` source: **LIVE** →
     `Date.now() - followedSnapshot.startedAt`; **frozen** (`followedFinal` set) →
     `followedFinal.elapsedMs` (stops ticking). `usageStr = ` · $c • N tok`` when present.
  5. Body: `(followedSnapshot.history).slice(-FOLLOW_TRACE_LINES).map(formatHistoryLine)`, each
     line `truncateToWidth(., width - 2)`; `…` when empty.
  6. Footer: `esc back to list`; while unresolved, an extra `finalizing…` hint line.
- Cache: as today, `render` caches by `width`; `invalidate()` clears it. The command's 1 s timer
  already calls `viewer.invalidate()` + `tui.requestRender()`, so follow re-reads the registry
  each tick (≈1 s trace latency — acceptable for v1).

### ② `SubagentRun` + `reconstructSubagentRuns` — add `toolCallId` (`src/subagent-viewer.ts`)

- `SubagentRun` gains `toolCallId?: string`.
- `reconstructSubagentRuns`: extend `BranchMessage` with `toolCallId?: string` and read the
  toolResult message's `toolCallId` into the run. **Verified** against pi 0.82.0's branch shape
  (`entry.message.toolCallId` on toolResult messages — see `dist/core/export-html/template.js:1466`
  and `export-html/index.js:141`); it is the same id `InFlightSubagent.id` is set to. Optional
  field → fully backward-compatible, and **no change to `SubagentToolDetails`** is needed.

### ③ `formatHistoryLine` — export (`pi-agent-ext-subagent/src/subagent-tool.ts`)

- `function formatHistoryLine` → `export function formatHistoryLine`. It already produces exactly
  the per-line format the follow body wants (`→ tool <args>` / `← tool ✓ <preview>` / `⚠ error`),
  matching the inline `Ctrl-O` trace so the two surfaces never drift. `previewPayload` stays
  private (internal to the export). Mirrors the already-exported `summarizeLatestAction`.

### ④ `createSubagentsCommand` — wire `getRuns` (`src/subagents-command.ts`)

- In addition to the open-time `runs = reconstructSubagentRuns(branch)` (unchanged, seeds the
  list), pass `getRuns: () => reconstructSubagentRuns(branch)` (live). The viewer calls `getRuns`
  **only** when resolving a followed run's completion; the list keeps using the seeded snapshot.

### Constants

- `FOLLOW_TRACE_LINES = 40` (tail-f window; tunable).
- `FOLLOW_FINALIZE_GRACE_TICKS = 5` (≈5 s before the `ended` fallback).

## Data flow

```
subagent tool execute()  ──(UNCHANGED)──▶  inFlight start / updateModel / update(history) / end
                                            (finally → end(toolCallId) still runs)

/subagents command  ──▶  SubagentViewer({ runs, getRunning, getRuns, onClose }) + 1s invalidate timer
  list.entries = [ getRunning()… ] ++ [ runs… ]            (unified, selectable)
  enter on a running row  ─▶  enterFollow(id)              (followedId set, view = follow)
  follow.render (each tick):
     r = getRunning().find(followedId)
       ├─ found  → LIVE    (snapshot ← registry entry; status running; trace = history last N)
       └─ absent → resolve getRuns().find(toolCallId === followedId)
                     ├─ hit   → freeze (status/usage/output ← completed run)
                     └─ miss   → finalizing… (≤ grace) → ended fallback
  esc  ─▶ list   (the run now appears in the Completed section)
```

## Edge cases / error handling

- **Registry↔branch timing window** (entry deleted by `end()`, branch result not yet
  reconstructable in the same tick): show last `followedSnapshot` + a `finalizing…` hint; resolve
  on the next tick. After `FOLLOW_FINALIZE_GRACE_TICKS` ticks still unresolved → the `followEnded`
  flag drives a neutral `ended` banner (a follow-view-local display state, not a
  `SubagentRun.status` value). **Never hangs.**
- **Pre-flight `failEarly` run** (no persistence, no branch result): `ended` banner + last
  snapshot (possibly empty). Rare; acceptable.
- **`getRuns()` throws**: swallowed (best-effort); fall back to `ended`. The viewer never crashes.
- **Multiple running**: cursor selects any one; follow it; the rest remain in the Running section
  on `esc` back to list.
- **No running subagents**: list shows only Completed; cannot enter follow (no selectable running
  row); `enter` on completed → existing `output`.
- **Followed, then `esc` mid-run**: back to list; run still in Running section; can re-enter follow.
- **Width**: trace lines `truncateToWidth(line, width - 2)`; header truncated to `width`.
- Registry methods are plain `Map` ops (do not throw); `renderFollow` stays defensive regardless.

## Testing

Extend `pi-agent-ext-workflow/tests/subagent-viewer.test.ts` (existing) and
`tests/subagents-command.test.ts`:

- **list**: unified `entries` render Running + Completed; cursor spans both; `▶` on the selected
  row; indices clamp after a running entry disappears.
- **list → enter(running)** → `view === "follow"` and `followedId` set.
- **list → enter(completed)** → `view === "output"` (regression guard).
- **follow LIVE**: `getRunning` returns an entry with `history` → renders `shortModel` +
  `running` + trace lines (`→ read`, `← read ✓`, `⚠ …`); `elapsed` derived from `startedAt`.
- **follow COMPLETED**: `getRunning` empty; `getRuns` returns a run with matching `toolCallId`,
  `status: done`, usage → freeze renders `✓ done` + `$c • N tok`; trace frozen at the last
  snapshot.
- **follow finalizing window**: `getRunning` empty, `getRuns` returns `[]` → within grace shows
  `finalizing…`; past grace shows `ended`; **no throw**.
- **follow `esc`** → `view === "list"`.
- **`reconstructSubagentRuns`** reads `msg.toolCallId` → `SubagentRun.toolCallId`.
- **regression**: existing list / output / `esc` tests still pass; update selection-index
  assertions for the unified cursor.
- **command wiring**: `createSubagentsCommand` passes a `getRuns` that reflects branch changes
  (live re-scan).

No new tool, no tool-schema change → **no schema-cost impact**. No new extension registration
(the viewer + command are already mounted) → **no extension-wiring change**.

## Out of scope (v1.5, noted only)

- Event-driven (`<250 ms`) trace invalidation via a `SubagentInFlightRegistry` subscribe hook
  (today the follow view updates at the 1 s timer cadence; the inline `Ctrl-O` trace stays
  real-time regardless).
- Manual scrollback (`up`/`down` to scroll the trace window) inside follow.
- Follow state persisting across `/subagents` re-opens (today it is per-viewer-session).
