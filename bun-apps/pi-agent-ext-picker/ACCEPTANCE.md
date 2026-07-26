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

Exercised once the full `createMenuPicker` (CustomEditor + nonCapturing overlay)
is wired. Each must behave as claude-code's picker does:

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

- [ ] type `/` in the real prompt → slash-command list appears (data from the
      existing `CombinedAutocompleteProvider`)
- [ ] selecting a command runs it (the tracer bullet, ticket 06's original scope)

## Known follow-ups (post-acceptance)

- full `createMenuPicker` CustomEditor + nonCapturing SelectList overlay (slice 2)
- themed `SelectListTheme` (slice 1 uses PLAIN_THEME for deterministic snapshots)
- the `\x1B[0m` SGR-reset SelectList appends per line is cosmetic in PLAIN output
