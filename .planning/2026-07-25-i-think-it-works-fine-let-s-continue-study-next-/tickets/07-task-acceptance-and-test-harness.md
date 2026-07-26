---
type: task
blocked by: 05, 06
status: in-progress (slices 1+2+3 done; awaits §B/§C manual verification)
---

# 07 — Task: acceptance + test harness for the interactive component

## Question

How do we verify an interactive TUI component that resists unit-testing? Stand up: a render-snapshot test of the isolated component (deterministic input → expected lines), a manual test script / keybinding matrix (↓/↑/Enter/Esc/type-to-filter/empty-state), and the acceptance checklist the component must pass.

## What resolving it looks like

A test harness + acceptance checklist committed; the component's done-ness becomes machine-checkable, not eyeball-only.

## Progress (2026-07-26)

**Slice 1 — render-snapshot harness: DONE.** New package `bun-apps/pi-agent-ext-picker/`:
- `src/menu-picker.ts` — `renderMenuLines({items, query, selectedIndex, width, maxVisible, theme})` (deterministic render core: `fuzzyFilter` pre-filters, `SelectList` owns layout/scroll/truncate; selection clamped). `PLAIN_THEME` for stable snapshots.
- `tests/menu-picker.test.ts` — 5 pass / 3 snapshots (all-items, fuzzy-narrow, empty-state, clamp, width-respect).
- `ACCEPTANCE.md` — section A (machine-checked ✓) + B (manual keybinding matrix, pending the full component) + C (slash-command integration).

Proves the core of 07 — an interactive TUI component that "resists unit-testing" IS testable via its extracted deterministic render core. Snapshots look right (`→ /help` selected, column layout, `No matching commands` empty-state).

**Next slices** (each unblocks more of ACCEPTANCE.md B/C):
- slice 2: full `createMenuPicker` — `CustomEditor` subclass owning input + driving a `nonCapturing` SelectList overlay (the 06 gate mechanism). **DONE.**
  - `src/menu-render.ts` (testable, pi-tui only): `renderMenuLines` + `resolveSelectionByValue` (persist-by-value, 05) + `MenuOverlay` (stateful Component: query/selectedValue/selectedIndex; render delegates to renderMenuLines). **12 tests pass** (render snapshots, persist-by-value, overlay state→render, clamp, no-op-on-unchanged).
  - `src/menu-picker.ts` (interactive, pi-coding-agent): `MenuPickerEditor extends CustomEditor` + `createMenuPicker(ctx,opts)` factory. Wires `onChange→overlay.setQuery` (live filter); `handleInput` override intercepts `tui.select.up/down/confirm/cancel` via the stored `KeybindingsManager.matches` + CONSUMES them (onAction doesn't consume → would double-handle); shows a `nonCapturing` bottom-center overlay on construct; `accept`/`cancel`/`close` (hideOverlay + restore default editor), `closed`-guarded.
  - Verification: tsc-clean (src), 12 unit tests green, module load smoke ✓ (CustomEditor/agent.js resolve). Interactive wiring deferred to slice-3 consumer (ACCEPTANCE §B needs a trigger).
  - **Key build-fact**: `CustomEditor.onAction` handlers do NOT consume keys (`super.handleInput` always runs after) → must override `handleInput` + use the `keybindings` param (received in the factory) to `matches()` + `return` early. `tui.select.*` are valid `Keybinding` ids (no cast needed).
- slice 3: slash-command consumer (tracer bullet → ACCEPTANCE C). **DONE.**
  - `extensions/picker.ts`: opt-in (`PI_PICKER=1`) `onTerminalInput` trigger — `/` typed in an empty prompt opens `createMenuPicker` with `pi.getCommands()`; `onSelect` fills the prompt (`/name`); re-entry-guarded; inert without the env var (no disruption to normal `/cmd` or `/path`). Registered in `pi-agent/run-dir/manifest.json`.
  - `src/command-items.ts`: `toCommandItems` (SlashCommandInfo → SelectItem, leading-`/` normalized) — extracted + **3 tests**.
  - Verification: tsc-clean (src+extensions), **15 unit tests green** (12 render/overlay + 3 command-items), extension load smoke ✓. Interactive §B/§C = manual (`PI_PICKER=1 pi`).
  - **Limitation**: no public `ctx.ui.submit()` → select fills the prompt; the user presses Enter to run (vs claude-code's one-Enter run). Documented in ACCEPTANCE §C.

**07 deliverable complete**: test harness (15 machine-checked tests) + acceptance checklist (ACCEPTANCE.md §A machine / §B+§C manual). The component's done-ness IS machine-checkable. Remaining gate = user runs the §B/§C manual procedure (`PI_PICKER=1 pi`).
