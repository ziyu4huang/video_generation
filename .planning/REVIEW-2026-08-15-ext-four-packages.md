# Four-Package Extension Review + Claude-Code Subagent TUI Research — 2026-08-15

## 1. Header

- **Date**: 2026-08-15
- **Scope**: `bun-apps/pi-agent-ext-wayfind`, `bun-apps/pi-agent-ext-superpowers`, `bun-apps/pi-agent-ext-subagent`, `bun-apps/pi-agent-ext-core-task` (four-package incremental review)
- **Method**: wayfind two-axis review (Standards × Spec axes; STRONG/MODERATE/WEAK/LOW) + codebase-design vocabulary (monolith, stringly-typed seam, parser mirror, render vocabulary duplication); walker subagents dispatched at `origin/main`
- **Base**: `b66e1e19` (`origin/main` @ review time)
- **Companion research artifact**: Claude-Code (CC) subagent TUI concept → pi-agent gap map (§5), feeding the next-effort candidate (§7)

## 2. Review Findings → Dispositions

### wayfind (`bun-apps/pi-agent-ext-wayfind`)

| # | Severity | Axis | Finding | File:line | Disposition |
|---|----------|------|---------|-----------|-------------|
| 1 | STRONG | Standards | `pi.extensions` manifests a `pi-agent-ext-wayfind/dist/index.js` entry whose source `src/index.ts` does not exist; README:67 documents the same phantom | `pi.extensions`, README:67 | **FIXED** — #1388 |
| 2 | MODERATE | Spec | CONTEXT.md glossary stale: `webui:render` and `architecture-render` (329L), `effort-query` (354L) undocumented; statusbar undocumented | CONTEXT.md | NOT FIXED — future effort candidate |
| 3 | MODERATE | Standards | 5 skills marked `disable-model-invocation` are undiscoverable by the model (no listing surface) | skills/* | NOT FIXED |
| 4 | WEAK | Standards | `commands.ts:49` dual parser mirror (two parsers kept in lockstep by hand) | commands.ts:49 | NOT FIXED |
| 5 | WEAK | Spec | `stale-seam.ts:3` cites nonexistent `grill-seam.ts` (that twin belongs to hermes) | stale-seam.ts:3 | NOT FIXED |

### superpowers (`bun-apps/pi-agent-ext-superpowers`)

| # | Severity | Axis | Finding | File:line | Disposition |
|---|----------|------|---------|-----------|-------------|
| 1 | MODERATE | Standards | No CONTEXT.md — package lacks a domain context doc | — | **FIXED** — #1389 added CONTEXT.md |
| 2 | MODERATE | Spec | SDD skill references stale `.superpowers/sdd` path | SDD skill :124, :132 | **FIXED** — #1389 override-documentation in CONTEXT.md; path pin preserved |
| 3 | LOW | Standards | `docs/superpowers` symlink tension (documented) | docs/ | NOT FIXED — accepted, documented |
| 4 | — | Standards | Clean cross-references otherwise | — | no action |

### core-task (`bun-apps/pi-agent-ext-core-task`)

| # | Severity | Axis | Finding | File:line | Disposition |
|---|----------|------|---------|-----------|-------------|
| 1 | MODERATE | Standards | Untyped `ctx` casts ×5 — `ctx as { sessionManager?: … }` pattern repeated | extensions/core-task.ts:106,113,114,141,143 | NOT FIXED — future effort candidate |
| 2 | MODERATE | Standards | Stringly-typed `globalThis` seams: `__piGoalActive`, `__piPlan*` (`__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary`), `__piCoreTaskStatusWidget` | extensions/core-task.ts:47–62, shared/status-widget.ts | NOT FIXED — see §3 seams |
| 3 | MODERATE | Standards | `goal.ts` 1522L monolith (largest file in package; next is reviewer.ts 493L) | src/goal/goal.ts | NOT FIXED |

### subagent (`bun-apps/pi-agent-ext-subagent`)

| # | Severity | Axis | Finding | File:line | Disposition |
|---|----------|------|---------|-----------|-------------|
| 1 | MODERATE | Standards | Context widget non-focusable (TUI routes raw input only to the single `focusedComponent`, so `handleInput` never fires) + Ctrl-O detected by byte-sniff `\x0f` in `onTerminalInput` data | subagent-context-widget.ts:5–19, :50–55 | NOT FIXED — §7 candidate |
| 2 | MODERATE | Spec | Viewer follow/output is input-dead (no interactive keys beyond documented navigation) | subagent-viewer.ts | NOT FIXED |
| 3 | MODERATE | Standards | Four render vocabularies for the same run data: `formatSubagentLive` / `formatSubagentTrace` / `buildLiveTable` / `renderActivityRow` | subagent-tool-render.ts:167, subagent-context-widget.ts:34,177 | NOT FIXED — §7 consolidation candidate |

## 3. core-task Architecture Map (summary)

**Modules** (~21.2k LOC total):

| Module | Contents | Notes |
|--------|----------|-------|
| `extensions/core-task.ts` | registration entry; wires overlays into shared status widget | untyped ctx casts (#1) |
| `src/goal/` | goal.ts (1522L monolith), reviewer, auditor, shield, backoff, quota-retry, repetition, overlay, persistence | #3 |
| `src/loop/` | loop.ts (346L), loop-state, loop-persistence, overlay | mutually exclusive with goal |
| `src/plan/` | coordinator, parse, types | Plan A coordination |
| `src/todo/` | todo.ts, overlay, state, tool, view | session-only, in-memory |
| `src/ask-user/` | dialog-builder, stateful-view, tab-components, props-adapter, component-binding | see below |
| `src/shared/` | status-widget.ts | composite host |

**Composite widget sections 0–1** (CoreTaskStatusWidget `addSection`):
- order 0: `goal` (goalOverlay.render) — shares order 0 with `loop` (mutual exclusion, only one ever non-empty)
- order 1: `todo` (todoOverlay.render + `inspect()`)

**ask-user component model**: dialog-builder composes pi-tui `Component`s (`Input`, `Spacer`, `wrapTextWithAnsi`); stateful-view + props-adapter + tab-components/tab-content-strategy drive a tabbed questionnaire; component-binding glues focused-component input to the state reducer.

**Seams**:
1. **Events**: `pi.on` session_start / session_compact / session_tree / session_shutdown / tool_execution_end drive all four subsystems.
2. **globalThis**: `__piGoalActive` (loop reads it), `__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` (wayfind chain.ts:58 reads them), `__piCoreTaskStatusWidget` (cross-extension widget discovery) — process-singleton runtime contracts.
3. **Undo socket**: none today — widget discovery is globalThis, not a registry/socket.

**Friction ×3**: (a) goal.ts monolith; (b) stringly globalThis seams untyped; (c) repeated untyped ctx casts at every event handler that needs sessionManager.

## 4. subagent TUI Surface Inventory

Four display artifacts, all pi-tui-only rendering (no DOM/webui path):

| Surface | Artifact | Entry point |
|---------|----------|-------------|
| A — inline tool line | `subagent-tool-render.ts` (`renderSubagentCall`/`renderSubagentResult`, `formatSubagentLive` partial branch) | registering tool's ToolExecutionComponent (current turn, foreground) |
| B — aboveEditor context box | `subagent-context-widget.ts` (`setWidget` factory, non-focusable, collapsed headers, background runs via `registry.views({ foreground: false })`) | auto-wired at extension load |
| C — interactive viewer | `subagent-viewer.ts` (Key/matchesKey navigation) | `/subagents` (`subagents-command.ts`) |
| D — trace/table formats | `formatSubagentTrace`, `buildLiveTable`, `renderActivityRow` | consumed by A/B/C |

Fore/background exclusion rule: Surface A renders foreground runs inline; Surface B filters to background runs so the two never duplicate; Surface C shows both via the shared registry.

## 5. Claude-Code Subagent TUI → pi-agent Gap Map

| CC concept | CC behavior | pi-agent today | Gap | Confidence |
|------------|-------------|----------------|-----|------------|
| Task-row protocol | `Task` tool renders one live row per spawned subagent (description, status, elapsed), auto-updating | Surface B shows collapsed headers for background runs only; foreground is a static call/result line | no unified always-live per-task row | high |
| Ctrl+B backgrounding + notification | foreground subagent detaches to background; bell/notification on completion | no detach; foreground blocks the turn; no completion notification | both missing | high (mechanism) / approximate (exact CC keybinding semantics) |
| Transcript / verbose expand | expand a Task row to the full subagent transcript inline | `expanded` flag + `toggle()` exist but unreachable (non-focusable widget); transcript only via `/subagents` viewer | key-path wiring (`ui.onTerminalInput` / `pi.registerShortcut`) not done | high |
| Esc | Esc interrupts/backs out of a running subagent view | no interrupt from display surfaces | missing | approximate |
| ProgressState tokens/cost | per-row token + cost metering surfaces in the task row | RunView has elapsedMs + toolCallCount; no tokens/cost in RunView or RunView rendering | enrichment needed | high (gap) / approximate (CC field names) |
| `/agents` ↔ `/subagents` | CC `/agents` manages agent definitions + running agents | `/subagents` viewer exists; no definition-management half | partial parity | high |

## 6. Cross-references

- **`.planning/REVIEW-2026-08-15-pi-agent.md`** — sibling review of the `bun-apps/pi-agent` package itself (stale-dist self-heal, #1354 range). Complementary: that file reviews the host harness; this file reviews the four extension packages riding on it.
- **`docs/research-tui-agent-webui-hybrids.md`** (#1384) — sibling research on TUI↔webui hybrid architecture. Complementary: that research covers the display-transport axis; this file's §5 covers the subagent-TUI interaction axis. §7's focusable-widget work must stay consistent with both.

## 7. Next Effort Candidate — CC-style Subagent TUI in core-task

**Status: brainstorming pending** (no spec, no tickets).

Sketch: composite-widget subagents section in CoreTaskStatusWidget consuming `registry.views()` (both foreground + background) as live task rows; completion notification (bell/toast) + Ctrl-B detach of a foreground subagent to background; RunView enriched with tokens/cost (progress-state parity); focusable widget (or global key path) to expand a row to transcript. Consolidates the four render vocabularies (subagent #3) and resolves non-focusability + `\x0f` sniff (subagent #1). Brainstorm under `.planning/<effort>/brainstorm/` per standing rule.
