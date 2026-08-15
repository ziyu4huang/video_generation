> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-25-i-think-it-works-fine-let-s-continue-study-next-

> **Status: DESTINATION REACHED (2026-07-26).** All 7 tickets closed. Component
> built (`bun-apps/pi-agent-ext-picker/`), 28 machine-checked tests green, first
> consumer (slash-command menu, opt-in `PI_PICKER=1`) shipped across PRs #848 /
> #852 / #856 / #864 / #866. §B/§C live-render is a non-blocking recommended
> user-sanity (see ticket 07 resolution). Map archived.

## Destination

A reusable, claude-code-style **interactive menu component** for the pi-agent TUI — arrow-key (↓/↑) navigable, type-to-filter, Enter-to-select — that any feature (slash-command menu, `/subagents` list, mode picker, …) can consume. The map ends when the component's **spec**, **build path**, **input-ownership model**, and **first consumer (slash-command)** are settled enough to hand to a build plan.

## Notes

- **Domain**: pi-agent TUI. The real TUI code is upstream in the vendored `@earendil-works/pi-coding-agent` package; this repo's `bun-apps/pi-agent` is a thin CLI wrapper, and `pi-agent/src/patches/` already patches upstream files (precedent for the patch path).
- **Extension TUI surface exists**: `ctx.ui.custom(fn, {overlay:true})`, `ctx.ui.setWidget(name, lines, {placement:"belowEditor"})`, `Key.down`/`Key.up` + `matchesKey`, and a `MenuComponent` overlay example in `docs/tui.md` (Pattern 5). Feasibility of "is it possible?" → **YES**.
- **Fact freshness ⚠️**: `sync-main` was **1 commit behind `origin/main`** at chart time. Rebase before executing any ticket that trusts repo/dist facts (esp. 02, 03, 04).
- **Skills every session should consult**: `grilling` + `domain-modeling` (decision tickets 03/05); pi docs `docs/tui.md` + `examples/extensions/*`.
- **Standing preference**: prefer the extension path (`ctx.ui.custom` overlay / `setWidget`) over patching upstream — **02 confirmed no hard wall exists**.
- **Reframe of 05**: the destination's "generic menu component" is most likely **`SelectList` rendered in an overlay** (built-in, docs say don't rebuild), driven by the existing `CombinedAutocompleteProvider` — not a from-scratch component. Ticket 05 should spec the *integration + input model + parity*, not a new widget class.
- Conversational language: 繁體中文; all written artifacts: English.

## Decisions so far

- [01 — Research: claude-code's interactive picker UX](tickets/01-research-claude-code-picker-ux.md) — claude-code has **two** picker semantics: `Autocomplete` (inline, `/`+`@`, **Tab**-accept) vs `Select` (modal, **Enter**-accept, J/K + Ctrl+N/P); keybindings are **context-scoped** (same key routes by active context). Documented bugs to avoid: prefix-match over-ranking, stray-arrow traps, raw-ANSI leakage, double-highlight, Tab data-loss.
- [02 — Research: pi-tui extension input surface](tickets/02-research-pi-tui-extension-input-surface.md) — extension surface is **fully sufficient, no upstream patch needed**. Mechanisms: overlay (`ctx.ui.custom({overlay:true})`) with focus/unfocus; **built-in `SelectList`** ("don't rebuild"); **`CustomEditor`** (Pattern 7) for type-to-filter + arrow-nav coexistence; `setWidget({placement:"belowEditor"})`; `setFooter`. The slash-command **data source already exists** (`CombinedAutocompleteProvider` in `interactive-mode.js`). → effectively pre-decides **03** (extension-only) and mostly answers **04** (coexistence via CustomEditor).
- [03 — Decide: build path (extension vs patch vs upstream)](tickets/03-decide-build-path-ext-vs-patch.md) — **extension-only**, confirmed (2026-07-25). 02 proved the surface (overlay + built-in `SelectList` + `CustomEditor` + `setWidget`) fully sufficient — no hard wall, so no upstream patch/fork. Frontier advances to **04**.
- [04 — Prototype: input-ownership model](tickets/04-prototype-input-ownership-model.md) — **editor-driven coexistence**, confirmed (2026-07-25) via [`assets/proto-picker.ts`](assets/proto-picker.ts). Type filters live + ↑/↓(Ctrl-P/N) navigate simultaneously; nav keys must be non-printing (the constraint that buys coexistence). Drives the 05 component API: `triggerChar` + live `query` + `selectionIndex` (clamped, persistent) + non-printing `navKeys` + `onAccept`/`onCancel`; implemented as a `CustomEditor` subclass + `SelectList` overlay. Frontier advances to **05**.
- [05 — Decide: generic menu component spec](tickets/05-decide-generic-menu-component-spec.md) — **contract fixed** (2026-07-25). Component is a thin wrapper (SelectList already owns filter/nav/scroll/truncate/theme/width). Grilled: **fuzzy** filter (shipped `fuzzyFilter`, pre-filter + persist selection **by value**); placement = **overlay, bottom-anchored below editor**; items = **provider fn `(query) => SelectItem[]`**. Contract: `createMenuPicker(ctx, { items, trigger?, onSelect, onCancel?, maxVisible?, theme? })` → `EditorComponent`. Nav = `tui.select.*` keybindings (no `navKeys` prop). Resolves the 2 prior "not-yet-specified" (theming via `SelectListTheme`; width/truncation via `render(width)` + `truncatePrimary`). Frontier advances to **06**.
- [06 — Tracer-bullet / input-ownership gate](tickets/06-task-tracer-bullet-slash-command-consumer.md) — **GATE PASSED (code-reading, 2026-07-26)**. editor-driven coexistence is viable: show the menu overlay with `overlayOptions:{nonCapturing:true, anchor:"bottom"}` — the overlay renders but does NOT auto-focus (pi-tui `showOverlay` skips `setFocus` when `nonCapturing`), so the editor keeps input ownership (typed chars filter live; the CustomEditor subclass intercepts ↑/↓ to drive selection). Key correction: "no `handle.focus()`" was the wrong lever — overlays auto-focus on **show**; `nonCapturing:true` is the real switch (undocumented in tui.md but read by `showOverlay`). Confirms 04/05; the component build (slash-command tracer bullet) is unblocked.
- [07 — Task: acceptance + test harness](tickets/07-task-acceptance-and-test-harness.md) — **CLOSED (2026-07-26)**. Deliverable = test harness + acceptance checklist, both shipped. §A fully machine-verified (**28 tests**: 12 render/overlay + 3 command-items + 5 trigger glue + 8 handleInput routing, incl. the re-open-bug regression guard from PR #866). §B/§C (live-render) reclassified **non-blocking** — every remaining checkbox is a pi-tui / default-keybinding-config property our component already correctly requests (verified by code + tests), exercised by pi's own TUI without per-component live tests. Slash-command consumer (`extensions/picker.ts`, opt-in `PI_PICKER=1`) built + registered.

## Not yet specified

- **Second consumer**: retro-fit the existing `/subagents` panel onto the generic menu — only worth ticketing after the slash-command tracer bullet (06) proves the component.
  - *(Theming integration + terminal-width/truncation were graduated + resolved by 05 — `SelectListTheme` + SelectList's `render(width)` / `truncatePrimary`.)*

## Out of scope

- **Broad claude-code TUI parity / full gap analysis** — the destination is the picker component, not a parity audit (the "TUI 全面 gap 分析" option was rejected at chart time).
- **Free-form Tab/inline autocomplete** of arbitrary words / file paths / model names — the picker selects from bounded item lists, not open-vocabulary completion (the "自動完成建議" option was rejected at chart time).
- **Picker parity features ruled OUT at 05**: mouse support, multi-column layout, recent-items / recency ranking (component does fuzzy-rank only). SelectList provides scroll + truncation; nothing beyond that.
