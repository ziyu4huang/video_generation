# 07 — Interactive selectable wayfind widget

## Question

Graduated from the [02 prototype](02-prototype-below-editor-placement.md): now that the composite status (goal + loop + todo + wayfind) lives **below** the chat input and reads better there, the user wants it to be **interactive** — "move down" to focus/hover the wayfind render, then **select** it (Enter) to open a **wayfind detail** view. More advanced than claude-code's passive status bar.

Two sub-questions to resolve:
1. Can the *inline* status block take focus (hover-highlight + key handling), or only a separate panel?
2. What is "wayfind detail" — the full map? goal + todo + wayfind expanded? a live overlay?

## Feasibility (researched — trust this, don't re-dig)

- `setWidget` is **render-only**: `ExtensionWidgetOptions` declares only `placement` — no focus / input / onClick / key fields. The composite widget is passive.
- The TUI focus model is **editor ↔ modal** (binary): every interactive flow opens a dedicated component (`extensionSelector` / `extensionInput` / `dialog` / `selector`) via `ui.setFocus(it)`, then `setFocus(this.editor)` on close. **There is no "focus the inline widget" path.** Source: `modes/interactive/interactive-mode.js` (~50 `setFocus` calls, all editor↔component).
- Interactive building blocks DO exist via `ExtensionUIContext`: `select()` / `confirm()` / `input()` / `notify()` / `setStatus()` / `onTerminalInput(handler → { consume?, data? })` (raw key capture, can preempt the editor). Plus exported interactive components: `ExtensionSelectorComponent`, `ExtensionInputComponent`, `ExtensionEditorComponent`.

## The fork

- **Path A — inline focusable widget (full vision):** cursor-down into the status block, hover-highlight, Enter expands inline. Requires a **core patch** (new focus target type + key routing to widgets + editor-yields-on-down-at-bottom + a hover-state hook). High effort; crosses into the compiled core (via the repo's `bun-apps/pi-agent/src/patches/` monkey-patch flow).
- **Path B — keybind → wayfind detail panel (idiomatic MVP):** bind a key (dedicated shortcut, or overload cursor-down-at-empty-editor) to open a **wayfind detail** modal/overlay (map summary + goal + todo + wayfind status) via `select()` or a custom overlay component. Reuses existing machinery, **feasible today, no core change.** Captures the user's core intent ("select → show detail"). Loses the inline "hover" affordance.
- **Path C — hybrid:** ship Path B now; file Path A (inline-focus core enhancement) as a follow-up only if the hover polish is worth a core patch.

## Recommendation

**Path B** as the MVP. Define "wayfind detail" as the expanded view (map summary + goal + todo + wayfind status) in a modal. Defer Path A's inline hover unless it proves worth a core patch. Path C if the user wants the hover tracked as a future enhancement.

## Open detail (to grill when this ticket is worked)

- Confirm "wayfind detail" content (map? goal+todo+wayfind? something else).
- Pick the keybind (dedicated key vs cursor-down overload).
- Decide Path A as a real follow-up or drop it.

type: grilling
blocked by: 02

---

## Resolution (2026-08-09)

**Spun off to a separate effort — deferred scope expansion.** The placement + history destination this map sealed is unaffected (it shipped via **PR #999** `aa09621c` — below-editor status + per-cwd prompt history + browse hint).

Per the map's seal note, ticket 07 was scope expansion deferred to a future effort. It has now **seeded `2026-08-02-wayfind-interactive-widget`** ("Interactive Status-Bar Launcher — Robust Rebuild", map status: *CHARTED → route clear → PLAN → EXECUTE → SHIP*), so it closes here as graduated/spun-off — **not worked, not abandoned**.

Traceability of the spun-off work (accurate record; **NOT** an abandonment claim):
- The original launcher shipped as **PR #1019** (`1b5b5c63`, 2026-08-03) — Down-at-empty selector panel via `onTerminalInput` + a `bottom-center` `SelectList` overlay — then was **deliberately deleted 2026-08-07**: `38fe1372` ("remove Down-key status launcher popup" — the `onTerminalInput` teardown was unreliable across session lifecycle) and `50906350` ("remove key-triggered overlay menus that orphaned at bottom" — the overlay orphaned at the bottom with an `invalidate()` re-entry cascade).
- The spun-off effort `2026-08-02-wayfind-interactive-widget` is **STILL PLANNED**, chartered specifically to rebuild robustly on a different surface — `pi.registerShortcut` (SDK-managed → no teardown hazard) + an overlay-free inline `CustomEditor` (nothing to orphan) — eliminating both documented failure modes. See its `tickets/04-robust-rebuild-after-pr1019-deletion.md`.

The interaction this ticket scoped is therefore tracked forward, not dropped.

closed: 2026-08-09 (spun off → `2026-08-02-wayfind-interactive-widget`)
