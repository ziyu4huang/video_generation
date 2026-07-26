---
type: grilling
blocked by: 01, 04
status: closed
resolved: 2026-07-25
---

# 05 — Decide: generic menu component spec (API + placement + parity scope)

## Question

What is the reusable component's interface that slash-command, `/subagents`, and mode-picker all call? Decide via `grilling` + `domain-modeling`: items provider, filter function, render hook, on-select callback, **placement** (overlay-on-editor vs `belowEditor` widget vs inline input-border), and the **parity scope** — in: ↓/↑ + Enter + type-to-filter + Esc-dismiss; possibly out: mouse, scroll, multi-column, fuzzy match, recent-items sort.

## What resolving it looks like

A short component contract (signature + state machine) recorded here — precise enough that **06** can wire a consumer against it. This is where out-of-scope parity features get ruled (update the map's **Out of scope**).

## Resolution (2026-07-25)

### Headline

The generic component is a **thin wrapper** around pi-tui's built-in `SelectList` + a `CustomEditor` subclass + an overlay. `SelectList` already owns filtering, nav (via `tui.select.up/down` **keybindings** — user-configurable, so no `navKeys` prop), accept/cancel callbacks, scroll (`maxVisible`), truncation (`truncatePrimary`), width-responsiveness (`render(width)`), and theming (`SelectListTheme`). The wrapper adds: trigger detection, live-query wiring, fuzzy pre-filter + selection persistence by value, and overlay lifecycle.

### Decisions (grilled)

- **Filter = fuzzy** — pre-filter with pi-tui's shipped `fuzzyFilter` (superset of substring; standard claude-code/fzf feel). `SelectList`'s built-in `startsWith` is NOT used (too weak + resets selection).
- **Selection persists by value** — after each fuzzy re-filter, restore the highlight to the item whose `value` matches the previously-selected value (clamp to 0 if absent). Overrides `SelectList`'s default reset-to-0.
- **Placement = overlay, bottom-anchored below the editor** — `ctx.ui.custom(..., { overlay: true, overlayOptions: { anchor: "bottom" (or bottom-center), ... } })`. claude-code-style drop-below-input.
- **Items source = provider function** `(query: string) => SelectItem[]`. The component ALWAYS fuzzy-filters the returned items by `query` (consistent behavior); the `query` arg lets sources pre-narrow if they choose. 06 wraps any source (incl. `CombinedAutocompleteProvider`) into this shape.

### Component contract (→ 06 wires against this)

```ts
import type { SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import type { EditorComponent } from "..."; // CustomEditor base

interface MenuPickerOptions {
  /** Items source. Called with the live query (text after the trigger). */
  items: (query: string) => SelectItem[];
  /** Char that opens the picker when typed at a trigger position. Default "/". */
  trigger?: string;
  /** Accept — fired on Enter (SelectList.onSelect). */
  onSelect: (item: SelectItem, query: string) => void;
  /** Cancel — fired on Esc (SelectList.onCancel). Buffer is retained. */
  onCancel?: (query: string) => void;
  /** Visible rows in the scroll viewport. Default 8. */
  maxVisible?: number;
  /** Theme overrides; defaults derived from MarkdownTheme (accent/muted/dim/warning). */
  theme?: Partial<SelectListTheme>;
}

/** Returns a CustomEditor for ctx.ui.setEditorComponent(...). */
function createMenuPicker(ctx: ExtensionContext, opts: MenuPickerOptions): EditorComponent;
```
