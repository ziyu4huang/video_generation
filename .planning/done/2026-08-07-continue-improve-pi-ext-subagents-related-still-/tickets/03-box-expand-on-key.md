---
type: prototype
status: closed
blocked by: [02]
claimed: claude
---

# 03 — Box expand-on-key (surface the naturalized running log in the always-on box)

## Question

Wire the box's existing `toggle()` to a key so the naturalized running log is visible in the always-on above-editor box WITHOUT opening `/subagents`. Today `toggle()` is implemented + tested but bound to nothing, and the docked widget isn't focusable — so the box shows collapsed headers only.

Decide (HITL checkpoint):
1. **Key binding** — which key (find a free namespace; consider what `Ctrl-O`/`app.tools.expand` and the inline surface already claim).
2. **Focus mechanism** — how does the docked `setWidget` widget gain focus to receive the key (it isn't focusable in Stage A)?
3. **Default state** — collapsed-by-default vs expand-on-activity; auto-collapse when idle.
4. **Expanded content** — the live trace via `formatSubagentLive` using ticket 02's labels; decide a line cap (graduate the fog; `/subagents` follow caps at 40).

Prototype a working expand interaction (it can react to the chosen key + show the new labels) before finalizing.

## Acceptance

- [x] A key (Ctrl-O) expands/collapses the box — via the global `ctx.ui.onTerminalInput` hook (docked `setWidget` widgets can't be focused)
- [x] Expanded view shows the live tool trace rendered with 02's verb-led labels
- [x] Default = collapsed-until-key; idle (no runs) → invisible (already worked)
- [x] No regression to the inline surface — Ctrl-O coexists: it toggles the box AND keeps firing the inline `app.tools.expand` (both expand together)
- [x] typecheck + tests green (462 pass / 0 fail)

## blocked by

02 (expanding to show machine text is pointless; the labels must land first). Also resolves file-overlap serialization (both touch `subagent-context-widget.ts`).

## Resolution

**Implemented + verified green 2026-08-07.** SHIP verdict from independent audit (6/6 invariants PASS) + gate re-run (typecheck clean, 462 pass / 0 fail, +8 new tests).

### Design (grilling decisions)
- **Key: Ctrl-O** toggles the box. Ctrl-O is RESERVED (`app.tools.expand`) → `pi.registerShortcut` can't claim it; wired via the raw `ctx.ui.onTerminalInput` hook instead (the only path for a reserved key).
- **Coexistence (better than "steal"):** the handler returns `{ consume: false }`, so after toggling the box the 0x0F byte proceeds to the editor → `app.tools.expand` ALSO fires. **Ctrl-O now expands/collapses BOTH the box and the inline tool output together** ("show all detail"). Verified against pi-tui `handleTerminalInput` dispatch: inputListeners run first; a non-consuming return lets the focused component's keybinding path proceed.
- **Default: collapsed until key** (`expanded=false` unchanged); idle (no runs) → `render()` returns `[]` → invisible. No auto-expand-on-activity (rejected at grilling).

### What landed
- `src/subagent-context-widget.ts`: new exported `isCtrlO(data)` (detects C0 byte 0x0F); new `SubagentContextWidgetHandle { dispose; toggle }`; `installSubagentContextWidget` now captures `tuiRef` (refreshed per factory call) and returns a handle whose `toggle()` flips `expanded` + calls `tuiRef?.requestRender()`. Headless/no-setWidget path returns a safe no-op handle.
- `extensions/subagent.ts`: registers `ctx.ui.onTerminalInput` in `session_start` — on Ctrl-O calls `widgetHandle.toggle()`, returns `{ consume: false }`. Guarded with `ctx.ui && typeof ctx.ui.onTerminalInput === "function"` (the test fixture's `ctx` has no `ui`).
- **Expanded rendering unchanged** — `renderRun`'s expanded branch already shows `formatSubagentLive` (now ticket-02's verb-led trace).

### Fog resolved by the build (cleared from Not-yet-specified)
- **Current-turn exclusion in the expanded box:** the box keeps filtering `!foreground` regardless of expand state — the current turn's inline call is never duplicated in the box, expanded or not. Decided: keep the exclusion.
- **Expanded-box line cap:** inherited from `formatSubagentLive`'s `maxTraceLines` (default 100). No separate cap needed.

### Test coverage (+8 new)
`isCtrlO` (bare 0x0F, embedded in a chunk, false for `\x0d`/`\x0e`/`\x1b[A`/letters/empty); `handle.toggle()` flips expanded + drives requestRender, safe before the factory runs, headless no-op; the onTerminalInput handler shape (0 toggles for non-Ctrl-O, 1 for `\x0f`, 2 for `ab\x0fcd`, always returns `{consume:false}`).

### Delivery
Shipped via branch `feat/subagent-box-expand` (squash-merge to `main`).
