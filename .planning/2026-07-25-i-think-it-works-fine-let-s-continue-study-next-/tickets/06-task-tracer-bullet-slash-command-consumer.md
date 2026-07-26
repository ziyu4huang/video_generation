---
type: task
blocked by: 03, 04, 05
status: open
---

# 06 — Task: tracer-bullet — slash-command as first consumer

## Question

Wire slash-commands as the first consumer of the generic menu: type `/` → filtered list → ↓/↑ → Enter runs the command. The vertical slice that proves the component end-to-end (the slash-commands data source already exists in `dist/core/slash-commands`).

## What resolving it looks like

A working slash-command menu in the TUI, demoable. Resolves nothing new about the destination but unblocks the test harness (**07**) and graduates the "/subagents retro-fit" fog once the component is proven.

## Status (paused 2026-07-25)

**Where it stopped**: a throwaway crux-test spike (`extensions/picker-spike.ts`, since deleted) was built + loaded via `pi -e` + run interactively, but the decisive trace observation wasn't captured (paste didn't render) — **that observation is the gate**. Spike is deleted; rebuild from this note when resuming.

**The gate (one observation)**: with an UNFOCUSED overlay visible (`ctx.ui.custom({overlay:true, overlayOptions:{anchor:"bottom"}})`, no `handle.focus()`), do typed chars reach the editor or the overlay?
- typed chars appear as **`[editor]`** → editor-driven works → build the full `MenuPickerEditor` (05 contract) → 06 done.
- typed chars appear **only as `[overlay]`** → overlay steals input → editor-driven is NOT viable → **revise 04/05 to overlay-driven (modal)**, then 06.

This is the "design-meets-reality" step; everything in 01–05 is decided against the assumption it passes.
