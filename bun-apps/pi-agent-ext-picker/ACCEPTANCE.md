# Acceptance checklist — interactive menu component

The interactive TUI layer resists unit-testing; acceptance is split into
**machine-checked** (render-snapshot, in `tests/`) and **manual** (keybinding
matrix, run against the live TUI) sections. The component is "done" when both
pass.

## A. Machine-checked

### Render core — `tests/menu-render.test.ts` (pins `renderMenuLines`)

- [x] no query → all items, first selected, column layout
- [x] fuzzy query narrows + ranks by match quality
- [x] no matches → empty-state line, no item labels leak
- [x] `selectedIndex` clamps to the filtered list
- [x] render respects `width` (no line exceeds it)

### Interactive glue — `tests/picker-trigger.test.ts` + `tests/menu-picker.test.ts`

Drives the real trigger handler + `MenuPickerEditor.handleInput` against mock
ctx/tui/keybindings (the bytes a terminal sends for ↓/↑/Enter/Esc, mapped to the
`tui.select.*` ids the real KeybindingsManager uses):

- [x] trigger: `/` in an empty prompt opens the picker + consumes the char
- [x] trigger: no-op on a non-empty prompt, a non-`/` char, or without `PI_PICKER=1`
- [x] trigger: re-arms after close — `/` re-opens following Esc (pickerActive resets)
- [x] ↓ / ↑ move the selection; clamp at the top/bottom
- [x] Enter selects the highlighted item; empty-state (no items) Enter is a no-op
- [x] Esc fires onCancel (no selection); accept/cancel hide the overlay + restore the default editor
- [x] after close, further input is inert (closed guard)

## Launch (pre-run checklist)

Open a **new Terminal.app window** — the manual tests need a live interactive
TUI and cannot run inside an existing pi session.

> ⚠️ **Run-dir gotcha.** The global `pi` shim (`~/.pi/agent/bin/pi`) points at
> the `video_generation__memory` worktree, whose `run-dir/manifest.json` does
> **not** register the picker. pi resolves `run-dir/` relative to the pi-agent
> *package* (cwd-independent, via `import.meta.url`), so you MUST launch THIS
> worktree's pi-agent directly — `PI_PICKER=1 pi` alone will not load it.

```bash
cd /Users/huangziyu/proj/video_generation__subagent
PI_PICKER=1 bun bun-apps/pi-agent/src/cli.ts   # §B + §C (picker opt-in)
bun            bun-apps/pi-agent/src/cli.ts      # §C inert (NO PI_PICKER)
```

Confirm the picker actually loaded before testing:
```bash
bun bun-apps/pi-agent/src/cli.ts ext doctor | grep picker
# expect:  OK   pi-agent-ext-picker   thin · ...
```

## B. Manual — keybinding matrix (run against the live TUI)

**Status: component + consumer both BUILT (slices 2 + 3, merged). The routing
logic is now machine-checked (§A “Interactive glue”); what §B confirms is the
LIVE rendering only a real TUI can show — the overlay visually appears
bottom-center, typed chars reach the editor as a live fuzzy filter (the
`nonCapturing` focus actually holds), and the real terminal keybinding bytes
route correctly. Run via the Launch procedure above.** Each must behave as
claude-code's picker does:

- [ ] type `/` → picker opens (bottom-anchored overlay visible)
- [ ] **input ownership**: typed chars reach the EDITOR (live filter), NOT eaten
      by the overlay (the `nonCapturing` guarantee from ticket 06)
- [ ] keep typing → list filters live (fuzzy)
- [ ] `↓` / `↑` (or `Ctrl-N` / `Ctrl-P`) → selection moves, clamped at ends
- [ ] selection persists **by value** across query changes (05 contract)
- [ ] `Enter` → `onSelect(item)` fires, picker closes
- [ ] `Esc` → `onCancel()` fires, picker closes, editor buffer retained
- [ ] empty-state: a query matching nothing shows "No matching commands" + `Enter` is a no-op

## C. Integration — first consumer (slash-command menu)

**Status (2026-07-26): consumer BUILT (slice 3 / ticket 06) — `extensions/picker.ts`,
registered in `pi-agent/run-dir/manifest.json`. Opt-in via `PI_PICKER=1`.**
Manual test procedure:

```bash
# from a fresh Terminal.app, in this worktree (see "Launch" above):
PI_PICKER=1 bun bun-apps/pi-agent/src/cli.ts
# in the prompt:
#   /            → picker overlay opens (bottom-center), all commands listed
#   he           → live fuzzy filter → /help
#   ↓/↑          → selection moves
#   Enter        → onSelect fills the prompt with /help, picker closes
#   <Enter>      → runs /help (second Enter: no public submit API — see note)
#   Esc          → cancel, picker closes, prompt empty
```

- [ ] type `/` in an empty prompt → slash-command list appears
- [ ] selecting a command fills the prompt (runs on the next Enter — there is no
      public `submit` API; ticket 06's "Enter runs the command" is fill + Enter)
- [ ] inert without `PI_PICKER=1` (normal `/command` + `/path` usage unaffected)

## Known follow-ups (post-acceptance)

- auto-run on select: no public `ctx.ui.submit()` API — the consumer fills the
  prompt (`setEditorText`) + the user presses Enter. Revisit if a submit API lands.
- the `/`-trigger is opt-in (`PI_PICKER=1`) + empty-prompt-guarded to avoid
  hijacking `/path` typing; a wrapper-editor model (workflow-style, always-on)
  could host a non-disruptive inline dropdown later.
- themed `SelectListTheme` (slice 1/2 use PLAIN_THEME for deterministic snapshots;
  the live editor already derives `theme.selectList` for the overlay).
- the `\x1B[0m` SGR-reset SelectList appends per line is cosmetic in PLAIN output.
