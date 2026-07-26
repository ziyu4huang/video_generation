# Acceptance checklist — interactive menu component

The interactive TUI layer resists unit-testing; acceptance is split into
**machine-checked** (render-snapshot, in `tests/`) and **manual** (keybinding
matrix, run against the live TUI) sections. The component is "done" when both
pass.

## A. Machine-checked (render-snapshot — `tests/menu-picker.test.ts`)

Pins the deterministic render core `renderMenuLines`:

- [x] no query → all items, first selected, column layout
- [x] fuzzy query narrows + ranks by match quality
- [x] no matches → empty-state line, no item labels leak
- [x] `selectedIndex` clamps to the filtered list
- [x] render respects `width` (no line exceeds it)

## B. Manual — keybinding matrix (run against the live TUI)

**Status (2026-07-26): the `MenuPickerEditor` component is BUILT (slice 2) — tsc-clean,
logic-tested, module loads. These items become testable once a CONSUMER wires it
(slash-command menu, slice 3 / ticket 06's tracer bullet).** Each must behave as
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
PI_PICKER=1 pi          # start pi with the picker opt-in
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
