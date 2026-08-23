# Spec — CC-Style Subagent TUI (core-task composite + subagent public surface)

> STATUS: approved 2026-08-15. Evidence file:line refs verified at `origin/main` (`96f85ae7`,
> REVIEW #1390 base was `b66e1e19`; all cited lines re-checked unchanged).

Evidence base: `.planning/REVIEW-2026-08-15-ext-four-packages.md` — §4 surface inventory,
§5 CC gap map, §7 sketch; subagent findings #1 (`subagent-context-widget.ts:5–19`, `:50–55`)
and #3 (`subagent-tool-render.ts:167`, `subagent-context-widget.ts:34,177`). Sibling research:
`docs/research-tui-agent-webui-hybrids.md` (#1384).

## §1 Goal

CC-parity (and beyond) subagent TUI:

- **Sole display home** = the core-task composite widget: a new **subagents section (order 4)**
  in `CoreTaskStatusWidget` renders live task rows for foreground AND background runs.
- The subagent package **opens its registry/trace as a public interface** (registry `views()`,
  `renderActivityRow`, `formatSubagentTrace`, detach lever) and **retires
  `subagent-context-widget.ts`** (REVIEW subagent #1: non-focusable + `\x0f` byte-sniff).
- **Import direction decision**: core-task imports the subagent package's PUBLIC lib surface —
  registry views + `renderActivityRow` via `@repo/pi-agent-ext-core-runtime`, `formatSubagentTrace`
  via `@repo/pi-agent-ext-subagent/src/subagent-tool-render.js` (add to its barrel, `index.ts:81`
  precedent). **NOT globalThis seams**: the existing `__pi*` seams (`__piGoalActive`,
  `__piPlan*`, `__piCoreTaskStatusWidget` — REVIEW core-task #2) are legacy; new work uses
  typed imports only.

## §2 Wave 1 — display foundation (tickets 01–04)

### Ticket 01 — subagents section in CoreTaskStatusWidget

**Today**: only Surface B (`subagent-context-widget.ts:239` — `registry.views({ foreground: false })`)
renders background runs below the editor; foreground is a static inline line (REVIEW §4 A).
**Change**: core-task adds `addSection({ id: "subagents", order: 4, ... })` — the widget contract
already documents section order `goal=0, todo=1, wayfind=2, coordinator=3`
(`status-widget.ts:16–18`; assignments at `extensions/core-task.ts:87–95`). Rows render via
`renderActivityRow` (`agent-row-display.ts:120`, already the shared row vocabulary) consuming
`registry.views({ foreground: false })`. Section collapses (renders nothing) when the view list
is empty. Foreground stays inline (Surface A) — no duplication (fore/background exclusion rule,
REVIEW §4).

### Ticket 02 — completion notification line

Transient **top-of-section line** when a background run completes: run name + elapsed +
one-line summary (`latestAction` from RunView), fading on the next render tick. Emits the
terminal bell (`\x07`) once. No toast system, no new widget — just section-internal state.

### Ticket 03 — RunView costUsd/tokensIn/tokensOut projection

**Today**: `RunView` (`core-runtime/src/run-view.ts:16–40`) has `elapsedMs` + `toolCallCount`
but no tokens/cost (REVIEW §5 ProgressState row). Child usage already flows: `AgentUsage`
(`core-runtime/src/agent.ts:312–319`: cost + tokens) delivered via the `onUsage` callback
(`subagent/src/spawn-subagent.ts:115–119`). **Change**: registry accrues usage from child
callbacks; `buildRunView` projects `costUsd` / `tokensIn` / `tokensOut`; row tail renders
`· $0.04` (reuse `fmtCost`, `agent-row-display.ts:183`). Frozen at terminal state, same as
`elapsedFrozen`.

### Ticket 04 — context-widget retirement

Delete `subagent-context-widget.ts` + its Ctrl-O `\x0f` byte-sniff install path
(`:50–55`) + `installSubagentContextWidget`. Migrate any unique behavior — the collapsed
latest-line (`latestMessageLine`, `subagent-tool-render.ts:97`, used at widget `:166`) — into
the new section's row rendering. The `/subagents` viewer (Surface C) is unchanged. Retires
REVIEW subagent #1 and shrinks the render-vocabulary quad (subagent #3) by one consumer.

## §3 Wave 2 — Ctrl-B backgrounding (tickets 05–06)

### Ticket 05 — detach pipeline in the subagent package

A foreground run converts to background: the child process survives, the parent's turn is
released (the awaited tool call resolves with a "detached" outcome), persistence owns the run
(resume-safe, `subagent-run-persistence.ts`), and RunView stays live via the registry
(foreground flag flips to false — it then appears in the new subagents section, ticket 01).

### Ticket 06 — claimable shortcut ctrl+b (global + in-viewer)

Register a claimable shortcut for `ctrl+b` (global via `pi.registerShortcut`; also handled
in the `/subagents` viewer for the focused run). Post-detach, show a notify line (ticket 02's
mechanism) confirming "detached → background". Follows the existing key-path guidance in
`subagent-context-widget.ts:24–25` (`ui.onTerminalInput` / `pi.registerShortcut` — neither
requires focus).

## §4 Wave 3 — focusable dock (tickets 07–08)

### Ticket 07 — ADR + focus-claim protocol (ADR BEFORE implementation)

The TUI routes raw input only to the single `focusedComponent` (REVIEW subagent #1 root cause),
so the dock claims focus by **prefix-claim on `onTerminalInput`**: `Ctrl-G s` enters dock focus
mode; `Esc` releases. Protocol keys: `j`/`k` scroll, `x` abort (with `y`/`n` confirm), `e`
expand trace overlay (`formatSubagentTrace`), Ctrl-B background (ticket 05 lever), `Enter`
jumps to the `/subagents` viewer focused on the run. **Zero upstream pi-core changes.** The ADR
(under `bun-apps/pi-agent-ext-core-task/docs/adr/` or the package's ADR home per CONTEXT
conventions) records the convention + the future upstream-focus-API migration path (consistent
with `docs/research-tui-agent-webui-hybrids.md`).

### Ticket 08 — implement the dock mode in core-task

core-task implements the dock mode consuming only the subagent package's public surface
(§1 import direction). The keymap is **table-driven** (`Array<{ key, action }>` → handler) so
tests exercise key routing without a real terminal (pattern: the onTerminalInput unit-test
seam already proven at `subagent-context-widget.ts:52`).

## §5 Non-goals

- No pi-core upstream changes (§4 is explicitly zero-upstream; upstream-focus-API is a recorded
  future path, not this effort).
- The workflow package (`pi-agent-ext-workflow`) is untouched.
- Esc-interrupt of the *agent* (native Esc behavior) is untouched.
- No RunStatus/ActivityStatus merge (that is the separate snapshot-row effort's spike).

## §6 Verification

- **Per-ticket canonical gates**: `( cd bun-apps/pi-agent-ext-subagent && bun run test )`
  (= `check` + `build` + `test:unit`) and `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )`.
- **Regressions**: row-render snapshots for the new section (empty/1-run/N-runs); notify
  fade-tick test; child-alive-after-detach test (child process outlives parent release);
  table-driven keymap tests (dock keys, ctrl+b).
- **Wave 3**: manual TUI smoke script (`docs/` or ticket 08) covering Ctrl-G s focus, Esc
  release, scroll/abort/expand/detach/Enter-jump, run against a real child run.
