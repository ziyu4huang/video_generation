---
type: research
blocked by: (none)
status: closed
claimed: wayfinder-chart-2026-07-25
---

# 02 — Research: pi-coding-agent TUI extension input surface

## Question

What can a pi-agent extension actually do TODAY toward an inline, type-to-filter + arrow-navigable menu, and where are the walls? Read `docs/tui.md` (Pattern 5 widgets above/below editor; the `MenuComponent` overlay example; `ctx.ui.custom(fn, {overlay:true})`; `ctx.ui.setWidget(name, lines, {placement:"belowEditor"})`; `Key.down`/`Key.up` + `matchesKey`; `handleInput` ownership) and the vendored `dist/core/slash-commands.*` + `dist/modes/interactive/interactive-mode.*` to see how slash commands currently resolve and whether any mid-keystroke input-interception hook exists.

## What resolving it looks like

A findings note written back here: (a) the extension capabilities that suffice as-is, (b) the gaps that would force a patch (→ feeds **03**), (c) the input-ownership constraint that drives the prototype in **04**. ⚠️ Confirm `sync-main` is current with `origin/main` before trusting dist facts.

## Resolution

Findings against vendored `@earendil-works/pi-coding-agent@0.82.0` (`docs/tui.md` + `dist/` + `examples/extensions/*`). **Headline: the extension surface is fully sufficient — no upstream patch is required.** This effectively pre-decides ticket **03** (build path → extension-only) and largely answers **04** (input-ownership → coexistence is achievable).

### (a) Capabilities that suffice as-is
1. **Overlay components** — `ctx.ui.custom((tui, theme, keybindings, done) => component, { overlay: true })`. Overlays:
   - carry **focus** / input ownership: `handle.focus()`, `handle.unfocus()`, `handle.unfocus({ target })`, `handle.setHidden()`, `handle.hide()`;
   - are **disposed on close** — create a fresh instance each show (don't cache);
   - support anchored positioning (9 anchors + offsetX/Y + margins + responsive `visible(termW, termH)`).
2. **Built-in `SelectList` + `SelectItem`** (from `@earendil-works/pi-tui`) — the docs are explicit: *"`SelectList`, `SettingsList`, `BorderedLoader` cover 90% of cases. Don't rebuild them."* `examples/extensions/preset.ts` already uses `SelectList` + `DynamicBorder` + `Key` in a real extension to build a `/preset` selector. → Our "generic menu" is likely **`SelectList` in an overlay**, not a from-scratch component (reframes ticket **05**).
3. **Custom editor** — Pattern 7: `ctx.ui.setEditorComponent(factory)` with a class extending `CustomEditor`. It receives **every keystroke** in `handleInput(data)` and decides what to do: handle it, or `super.handleInput(data)` to pass through (typing still works). The shipped `VimEditor` example proves you can mix modal key-handling with normal text entry. → **This is the mechanism for "type-to-filter + arrow-nav coexistence"** — intercept `/` to open an overlay; while the overlay is focused, arrows navigate it; other keys still reach the editor.
4. **Widgets above/below editor** — `ctx.ui.setWidget(id, lines | (tui,theme)=>{render,invalidate}, { placement: "belowEditor" })`. Persistent strips — good for hints/status, **not** for a modal picker.
5. **Custom footer** — `ctx.ui.setFooter((tui,theme,footerData)=>...)`; `footerData.getExtensionStatuses()`, `getGitBranch()`. (If the "bottom underline" the user pointed at is the footer/status bar, this is the hook.)
6. **Key handling** — `matchesKey(data, Key.down|Key.up|Key.enter|Key.escape|Key.tab|Key.ctrl("c"))`; call `tui.requestRender()` after any state change; custom components return `{ render, invalidate, handleInput }`.

### (b) Gaps that would force a patch → **none found**
Everything the destination needs (overlay + SelectList + CustomEditor + Key handling + focus management) is exposed to extensions. **No vendored patch required.** (Build-path ticket **03** can therefore resolve quickly toward extension-only.)

### (c) Input-ownership constraint → feeds ticket 04
Two viable ownership models, both achievable without patching:
- **Editor-driven (recommended for the claude-code feel)**: a `CustomEditor` subclass detects `/`, opens an overlay, and routes ↓/↑/Tab/Enter/Esc to it while the picker is open; all other keys pass to `super.handleInput()` so the user keeps typing/filtering. Gives claude-code-style coexistence. **Modal-only is NOT required.**
- **Overlay-driven (simpler, more modal)**: open a focused overlay that owns input entirely until Esc/Enter. Loses "keep typing to filter the editor buffer" but is the `MenuComponent` example as-shipped.

The only real open question for 04 is which model feels right → that's a prototype decision, not a capability gap.

### Bonus finding — the data source already exists
`dist/modes/interactive/interactive-mode.js` already builds a **`CombinedAutocompleteProvider`** (~line 415) merging: `BUILTIN_SLASH_COMMANDS` + prompt templates + extension commands + skill commands (`skill:<name>`). `rawKeyHint("/", "for commands")` (lines 519/530) confirms `/` is the documented trigger. → Ticket **06**'s slash-command consumer can feed the picker directly from this provider instead of re-deriving the command list.

### ⚠️ Fact-freshness note
Read from the vendored cache (`@0.82.0`, fixed version) — reliable for v0.82.0 regardless of the `sync-main`-vs-`origin/main` drift (that affects repo source, not the vendored package). Still rebase before any ticket that edits repo files.
