---
type: task
blocked by: 03, 04, 05
status: closed (gate resolved by code-reading)
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

## Resolution (2026-07-26) — GATE PASSED (code-reading, supersedes the empirical spike)

The gate is answered **definitively by reading the vendored pi-tui + pi-coding-agent source** — more reliable than the empirical spike (which the previous session couldn't get to render cleanly, because it was testing the wrong lever — see below).

### The precise input-ownership mechanism

**pi-tui `dist/tui.js` `showOverlay` (line 298–301):**
```js
if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
    this.setFocus(component);   // overlay auto-focuses on SHOW → grabs input
}
```
The overlay is pushed to `overlayStack` (→ it RENDERS) unconditionally (line 297); only the **focus** is conditional on `nonCapturing`.

**pi-coding-agent `dist/modes/interactive/interactive-mode.js` (line 1949–1960):**
```js
const resolveOptions = () => { … return options.overlayOptions; };   // passed THROUGH
const handle = this.ui.showOverlay(component, resolveOptions());
```
`overlayOptions` is forwarded verbatim as the `showOverlay` options → `overlayOptions: { nonCapturing: true }` reaches the `!options?.nonCapturing` check.

### Result: editor-driven coexistence is VIABLE

Show the menu overlay with `overlayOptions: { nonCapturing: true, anchor: "bottom", … }`:
- the overlay **renders** (SelectList menu visible, bottom-anchored);
- it does **NOT** auto-focus → the editor keeps input ownership;
- typed chars reach the **editor** (live filter);
- the `CustomEditor` subclass intercepts non-printing nav keys (↑/↓) to drive the overlay's selection.

**Gate outcome = "typed chars appear as `[editor]`" → editor-driven works → 04/05 assumption CONFIRMED.**

### Key correction to the original gate note

The note said test with "no `handle.focus()`". That was **insufficient**: an overlay auto-focuses on **show** (line 300) regardless of `handle.focus()` (which is for *re*-focusing). The real lever is `nonCapturing: true` in `overlayOptions`. This is why the previous empirical spike never captured a clean `[editor]` observation — its overlay was capturing the whole time. (Caveat: `nonCapturing` is undocumented in `docs/tui.md`'s overlayOptions list, but it is a real, read option in `showOverlay`.)

### Next

Gate cleared → 01–06 all decided. The actual tracer-bullet build (slash-command menu consuming the component) is now unblocked; the component = a `CustomEditor` subclass owning input + driving a `nonCapturing` SelectList overlay (the 05 contract). Hand to a build plan / 07 test harness.

## Resolution (2026-07-26) — TRACER BULLET BUILT (slice 3)

The slash-command consumer is implemented in `pi-agent-ext-picker/extensions/picker.ts`: opt-in via `PI_PICKER=1`, an `onTerminalInput` hook opens `createMenuPicker` when `/` is typed in an empty prompt; items = `pi.getCommands()`; ↓/↑ navigate, Enter fills the prompt with `/name`, Esc cancels. Re-entry-guarded + inert without the env var (no disruption). Registered in `pi-agent/run-dir/manifest.json`.

Limitation surfaced: there is no public `ctx.ui.submit()` API, so select *fills* the prompt rather than auto-running the command (claude-code runs on select). Fill + manual Enter is the tracer behavior; auto-run is a follow-up. Interactive §B/§C verification is manual (`PI_PICKER=1 pi`).
