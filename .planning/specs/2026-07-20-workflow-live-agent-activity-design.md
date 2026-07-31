# Design — pi-agent-ext-workflow: live subagent activity visibility (ActivityRow)

**Date:** 2026-07-20
**Package:** `bun-apps/pi-agent-ext-workflow`
**Status:** approved (brainstorming — Approach B, shared-component refactor)
**Git strategy:** fresh feature branch off `origin/main` (NOT `fix/pi-workflow-review-f1-f4` —
that branch is stale: it is even with `main`, its F1–F4 work already merged as #709)

## Background

This continues a lineage of two prior specs:

- `2026-07-18-subagent-tui-visibility-design.md` ("Level-1") shipped `renderCall`/`renderResult`
  and the `/subagents` viewer for the ad-hoc `subagent` tool, explicitly deferring "Level-2: live
  streaming of a running subagent's output" as blocked on an unconfirmed SDK hook.
- `2026-07-19-subagent-tool-v2-design.md` Phase 3 resolved that hook (`WorkflowAgent.run()`'s
  `onHistory`) and wired it into `subagent-tool.ts`'s `renderCall`/`renderResult({isPartial})` —
  so an ad-hoc `subagent` tool call now shows its latest tool call live, inline in the transcript,
  while it runs. **This part of the problem is already solved and is out of scope here.**

What was never closed: the same `onHistory` data already flows into `WorkflowAgentSnapshot.history`
(via `workflow-manager.ts`'s `onAgentHistory` handler, `src/workflow-manager.ts:508-517`) for
agents spawned by the `workflow` tool's `agent()`/`parallel()`/`pipeline()`, and into
`InFlightSubagent.history` (`subagent-in-flight.ts`) for the `/subagents` viewer's "Running"
section — but neither surface renders it as a live "what is it doing right now" line, and two of
the three surfaces do not even re-render when it updates:

1. **`task-panel.ts`** (the always-visible bottom panel) — `RUN_EVENTS` does not include
   `"agentHistory"`, and even in `detailed` mode, `renderRunBody` only shows
   `[id] icon label tokens model` — no current-action text at all.
2. **`workflow-ui.ts`**'s `/workflows` navigator — the `events` array passed to
   `manager.on(...)` in `openWorkflowNavigator` does not include `"agentHistory"` either, so a
   user who drills into a *running* agent's detail page (which does render `a.history`) does not
   see it update live; it only refreshes incidentally when some other event
   (`agentStart`/`agentEnd`/...) happens to fire.
3. **`subagent-viewer.ts`**'s `/subagents` "Running" section — data is already fresh (a 1s poll
   timer in `subagents-command.ts` re-reads `getRunning()` every second), but the render only
   shows a tool-call *count*, never the latest tool name/action.

Confirmed NOT a bug: `workflow-manager.ts` already correlates `onAgentEnd`/`onAgentHistory` to the
right snapshot entry via `callIndex` (F2, merged as #709) — no further fix needed there.

## Goal

- A running `workflow()` agent's current action is visible **without opening anything** — in the
  always-on bottom panel (detailed mode) — and also visible in the `/workflows` navigator's agent
  list (no need to drill into detail just to see "what is it doing").
- The `/workflows` navigator's agent-detail page live-tails: new history entries appear without a
  manual refresh, and auto-scrolls to the newest entry unless the user has manually scrolled up.
- The `/subagents` viewer's Running section shows the same kind of one-line "current action" the
  navigator and panel show, so the two surfaces speak one visual language.
- All three surfaces share one rendering primitive (`ActivityRow` + `renderActivityRow`), not
  three independently-hand-built string templates.

## Non-goals

- Anything about the ad-hoc `subagent` tool's own `renderCall`/`renderResult` — Phase 3 of
  `2026-07-19-subagent-tool-v2-design.md` already covers that; not touched here.
- A new panel mode (e.g. a merged cross-agent log tail). Considered as "Approach C" during
  brainstorming and explicitly rejected as out of scope for this round.
- Changing `renderPanel` (compact bottom-panel mode) — it stays a run-level aggregate line with no
  per-agent detail, unchanged.
- Any change to `WorkflowManager`'s event emission, journaling, or the `callIndex` correlation
  fix (F2) — already correct.
- Consolidating the *run-level* status-icon maps (`workflow-commands.ts`'s `STATUS_ICON`,
  `workflow-ui.ts`'s `STATUS_ICON` used for the "runs"/"phases" navigator views). Only
  *agent-level* rows are unified here.

## Design

### 1. `ActivityRow` + `renderActivityRow` — `src/display.ts` (extend, not a new file)

`display.ts` is already the shared import for `task-panel.ts` (`shorten`, `statusIcon`) and
`workflow-ui.ts` (`WorkflowAgentSnapshot`, `WorkflowSnapshot` types), so it is the natural home —
no new module needed, and it keeps the dependency graph a simple star instead of adding another
node.

```ts
export interface ActivityRow {
  /** Covers the union of statuses across workflow agents, subagent runs, and in-flight subagents. */
  status: WorkflowAgentStatus | "failed" | "timedout";
  actor: string;
  model?: string;
  elapsedMs?: number;
  tokens?: number;
  cost?: number;
  toolCalls?: number;
  /** One-line "what is it doing right now" — present only while running and history exists. */
  latestAction?: string;
  /** Static description shown when latestAction is absent (e.g. a finished run's taskPreview). */
  detail?: string;
  badge?: string;
}

export function activityGlyph(status: ActivityRow["status"]): { icon: string; color: string };

export function renderActivityRow(row: ActivityRow, theme: ThemeLike, maxDetailWidth?: number): string;
```

`activityGlyph` is the single canonical status→icon+color mapping for agent-level rows, replacing
three ad hoc versions: `statusIcon()` in `display.ts` (queued/running/done/error/skipped — kept as
a thin wrapper delegating to `activityGlyph` for backward compat with existing call sites that only
want the bare icon string), `subagent-viewer.ts`'s inline ternary (done/timedout/else), and
`subagent-in-flight`'s hardcoded `"⏳"`. Chosen glyphs (adjustable, not load-bearing): `queued "○"
dim`, `running "◆" warning`, `done "✓" success`, `error/failed "✗" error`, `skipped "-" dim`,
`timedout "⏱" warning`.

`renderActivityRow` builds `actor [model] · [elapsed] · [tokens] · [cost] · [toolCalls calls]`
metadata (theme-dim, `.filter(Boolean).join(" · ")`, exactly the existing pattern already used in
`task-panel.ts` and `renderPersistedResult`), then appends `latestAction` if present, else
`detail` if present. No adapters live here — see below.

**No adapters in `display.ts`.** Each consumer owns a small local `toActivityRow(x)` mapping next
to its own type, because a shared adapter for `SubagentRun`/`InFlightSubagent` would require
`display.ts` to import types from `subagent-viewer.ts`/`subagent-in-flight.ts`, and
`subagent-viewer.ts` already needs to import `renderActivityRow` FROM `display.ts` — a cycle.
Keeping adapters local means the dependency graph stays one-directional (consumers → `display.ts`).

### 2. `summarizeLatestAction` — `src/agent-history.ts` (extend)

```ts
export function summarizeLatestAction(history?: AgentHistoryEntry[]): string | undefined {
  const last = history?.[history.length - 1];
  if (!last) return undefined;
  if (last.kind === "toolCall") return `▸ ${last.toolName ?? "tool"}`;
  if (last.kind === "toolResult") return last.isError ? `✗ ${last.toolName ?? "tool"}` : `${last.toolName ?? "tool"} done`;
  if (last.kind === "error") return "✗ error";
  return "…thinking";
}
```

Deliberately terse (a status-line snippet, not content) — full text stays in the existing
"History:" block when the user drills into detail. `display.ts` already imports
`AgentHistoryEntry` from `agent-history.ts`, so this is a natural addition to an existing
dependency, not a new one.

### 3. Event-wiring fix (the actual bug)

- `task-panel.ts:21-32` — add `"agentHistory"` to `RUN_EVENTS`.
- `workflow-ui.ts:566` — add `"agentHistory"` to the `events` array inside `openWorkflowNavigator`.

Both re-render on every (already-throttled, ≥250ms/agent) history update. No new throttling is
added at this layer — see "Risk" below.

### 4. Consumer changes

**`task-panel.ts` `renderRunBody`** (detailed mode only; `renderPanel`/compact mode untouched):
for each visible agent, replace the hand-built line with a local
`toActivityRow(a: WorkflowAgentSnapshot): ActivityRow` (`latestAction:
a.status === "running" ? summarizeLatestAction(a.history) : undefined`) fed into
`renderActivityRow`.

**`subagent-viewer.ts` `renderList`**: both the "Running" section (currently
`⏳ agent ▸ model • Ns • N calls • taskPreview`) and the completed-runs list
(`badge #index agent ▸ taskPreview`) switch to local `toActivityRow` mappings +
`renderActivityRow`. Running rows gain `latestAction` for free — `InFlightSubagent.history` is
already live (the existing 1s poll timer in `subagents-command.ts` keeps it fresh); only the
render was missing it.

**`workflow-ui.ts`**: `NavigatorModel.agents()` (line ~159) gains a `history` field on the
returned `AgentRow` (reads `a.history`, already present on `WorkflowAgentSnapshot`). The
`"agents"` branch of `renderNavigator` (line ~396) builds `toActivityRow` per row and calls
`renderActivityRow` — so the agent list shows current action without drilling into detail.

### 5. Navigator live-tail auto-scroll — `NavigatorState` (`workflow-ui.ts`)

- New field `followLive = true`.
- `drill()`: pushing a `"detail"` frame resets `followLive = true`.
- `move(delta, count)`: in the `"detail"` branch, `delta < 0` (scrolling up) sets
  `followLive = false` immediately — explicit user intent to read older content.
- `pushScrollable` (in `renderNavigator`'s `"detail"` branch): when `state.followLive` is true,
  set `state.scroll = Number.MAX_SAFE_INTEGER` before the existing
  `Math.min(Math.max(0, state.scroll), maxScroll)` clamp — it naturally pins to the bottom with no
  change to the clamp logic itself. After computing `maxScroll`, if the (possibly user-set)
  `state.scroll >= maxScroll`, set `followLive = true` (re-arms when the user scrolls back down to
  the bottom manually).
- Visual: when `followLive && the selected agent's status === "running"`, prefix the existing
  `[start-end / total]` scroll indicator with a small `live` tag (accent/warning color). No change
  to the footer hint text itself.

`savedDetail` is intentionally excluded — it renders a static saved script, never live content, so
`followLive` has no meaning there.

## Data flow

```
WorkflowAgent.run() onHistory (throttled ≥250ms, existing)
  → workflow.ts agent()'s onAgentHistory callback (per call, callIndex-tagged)
  → WorkflowManager.onAgentHistory: agent.history = event.history; emit("agentHistory", {runId, callIndex, ...})
  → task-panel widget (NEW: subscribed) → renderRunBody → toActivityRow → renderActivityRow
  → /workflows navigator (NEW: subscribed, if open) → agents-list row AND/OR detail-page live tail
      (NEW: followLive auto-scroll)

Separately, ad-hoc `subagent` tool (unchanged, already live via Phase 3):
  onHistory → SubagentInFlightRegistry.update(id, history) (subagent-in-flight.ts)
  → subagents-command.ts's 1s poll timer → SubagentViewer.render()
      (NEW: renderList's Running row now surfaces latestAction via the same renderActivityRow)
```

## Error handling / edge cases

- **Re-render frequency**: up to 16 concurrent `parallel()` agents, each emitting a throttled
  (≥250ms) `agentHistory` event, is a worst case of ~64 events/sec funneling into
  `tui.requestRender()`. Not adding extra throttling here — `tui.requestRender()` already
  coalesces multiple calls within a paint tick (the existing `tokenUsage`-driven panel re-render
  already exercises this same pattern with similar event density), and per-agent-side throttling
  is already in place upstream. Flagged as an assumption to confirm during manual testing with a
  wide `parallel()` fan-out; if it proves to be a real bottleneck, a debounce at the
  widget/navigator subscription layer is a contained follow-up, not a redesign.
- Empty/undefined `history` → `summarizeLatestAction` returns `undefined` → `renderActivityRow`
  omits the segment (the existing `.filter(Boolean).join(...)` pattern already used throughout
  this file handles this for free).
- `toolName` undefined on a `toolCall`/`toolResult` entry → falls back to the literal `"tool"`.
- Agent finishes (or the whole run is deleted via `/workflows rm`) while its detail page is open →
  existing `if (a) {...}` guard in `renderNavigator`'s detail branch already handles a missing
  snapshot; `followLive`/the `live` tag simply stop having any visible effect (gated on
  `status === "running"`), no crash.

## Testing

- **`tests/agent-history.test.ts`** (extend): `summarizeLatestAction` for each `AgentHistoryEntry`
  kind (toolCall, toolResult success/error, error, plain text) and for empty/undefined history.
- **`tests/workflow-display.test.ts`** (extend, or a focused new
  `tests/display-activity-row.test.ts`): `renderActivityRow` — running row with `latestAction`;
  done row with `detail` instead; every optional field individually omitted renders cleanly (no
  stray separators); `activityGlyph` covers all seven statuses.
- **`tests/task-panel.test.ts`** (update existing assertions + add): detailed-mode running-agent
  lines now include the latest-action segment; a new test asserts the panel's widget re-renders on
  an `"agentHistory"` manager event (regression test for the event-wiring fix, mirroring F2's
  "assert the fix, not just the absence of a crash" style).
- **`tests/subagent-viewer.test.ts`** (update + add): Running row includes `latestAction`; a run
  with empty `history` renders without it (no crash, no dangling separator).
- **`tests/workflow-ui.test.ts`** (update + add): agents-list rows include `latestAction`;
  `NavigatorState.followLive` — drilling into a running agent's detail defaults to `true`; `k`/↑
  sets it `false`; scrolling back down to the max sets it `true` again; the `live` tag only shows
  for `status === "running"`.
- **Manual**: run a `workflow()` script with a `parallel()` of ≥3 agents — confirm the bottom
  detailed panel, the navigator's agent list, and the navigator's detail-page live tail (with
  auto-scroll pause/resume) all show current per-agent activity. Separately, dispatch an ad-hoc
  `subagent` tool call and open `/subagents` mid-run — confirm the Running row now shows its
  latest action too.

## Docs

- **`CONTEXT.md`**: add one glossary entry (near "Execution lifecycle" or a new small
  subsection), e.g.: "**Activity row**: The shared one-line renderer (`display.ts`,
  `renderActivityRow`) for an agent/subagent's live status — icon, actor, model, tokens, and
  (while running) its most recent tool call — used by the bottom task panel, the `/workflows`
  navigator's agent list and detail live-tail, and the `/subagents` viewer, so the three surfaces
  speak one visual language. _Avoid_: three independent hand-built status-line templates (the
  pre-existing state this replaces)."
- **`PRD.md`**: no change — this is presentation-only, no new tool/command surface.

## Risk

- **Low-medium.** No change to any tool contract, journal format, or event *payload* shape — only
  new event *subscriptions* (additive) and new rendering. The main real risk is the re-render
  frequency question noted above, which is a performance/polish concern to verify manually, not a
  correctness risk. The `ActivityRow` refactor itself touches three files' render output strings,
  which is why the existing test suites for all three need their string assertions updated — sized
  accordingly in the implementation plan (expect this to be the bulk of the diff by line count).
