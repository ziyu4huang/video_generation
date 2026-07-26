/**
 * menu-render.ts — the deterministic, TUI-runtime-free core of the menu picker.
 *
 * Everything here depends only on `@earendil-works/pi-tui` (no agent runtime),
 * so it is fully unit-testable via render-snapshots + state assertions. The
 * interactive layer (`MenuPickerEditor`, in menu-picker.ts) composes these.
 *
 *   renderMenuLines .... pure render (fuzzyFilter + SelectList layout)
 *   resolveSelectionByValue ... selection persists by value across re-filters (05)
 *   MenuOverlay ......... the overlay's stateful render surface (Component)
 */
import {
  SelectList,
  fuzzyFilter,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";

/** Plain (no-ANSI) theme — deterministic output for render-snapshot tests + tool
 * text. The real themed variant is constructed by the editor from EditorTheme. */
export const PLAIN_THEME: SelectListTheme = {
  selectedPrefix: (t) => t,
  selectedText: (t) => t,
  description: (t) => t,
  scrollInfo: (t) => t,
  noMatch: (t) => t,
};

export interface RenderMenuOpts {
  /** Full candidate list (before filtering). */
  items: SelectItem[];
  /** Fuzzy query (matched against item.value). Pass "" for no filtering. */
  query: string;
  /** Selection index into `items` (clamped). Default 0. */
  selectedIndex?: number;
  /** Render width in columns. Default 60. */
  width?: number;
  /** Max visible rows before scroll. Default 8. */
  maxVisible?: number;
  /** Theme. Defaults to PLAIN_THEME (deterministic). */
  theme?: SelectListTheme;
}

/** Render the menu lines for a query + selection — the testable render core.
 * `items` are fuzzy-filtered (score-ranked); SelectList owns layout/scroll. */
export function renderMenuLines(opts: RenderMenuOpts): string[] {
  const { items, query, selectedIndex = 0, width = 60, maxVisible = 8, theme = PLAIN_THEME } = opts;
  const filtered = query ? fuzzyFilter(items, query, (i) => i.value) : items;
  const list = new SelectList(filtered, maxVisible, theme);
  if (filtered.length > 0) list.setSelectedIndex(Math.min(selectedIndex, filtered.length - 1));
  return list.render(width);
}

/**
 * Selection persistence by value (ticket 05 decision).
 * After a fuzzy re-filter, restore the highlight to the item whose `value`
 * matches the previously-selected value; clamp to 0 if absent or no prevValue.
 * Overrides SelectList's default reset-to-0 on filter change.
 */
export function resolveSelectionByValue(filtered: SelectItem[], prevValue: string | undefined): number {
  if (!prevValue) return 0;
  const idx = filtered.findIndex((i) => i.value === prevValue);
  return idx < 0 ? 0 : idx;
}

export interface MenuOverlayOptions {
  /** Items source, called with the live query (lets providers pre-narrow). */
  items: (query: string) => SelectItem[];
  maxVisible?: number;
  theme?: SelectListTheme;
}

/**
 * The overlay's stateful render surface — a `Component` the TUI shows as a
 * nonCapturing, bottom-anchored overlay. Holds query + selection state, and
 * renders via `renderMenuLines`. Selection persists by value across query
 * changes (05). The editor wires `setInvalidate` to the TUI's invalidate so a
 * state change triggers a re-render.
 */
export class MenuOverlay implements Component {
  private readonly itemsFn: (query: string) => SelectItem[];
  private readonly maxVisible: number;
  private readonly theme: SelectListTheme;
  query = "";
  selectedValue: string | undefined;
  selectedIndex = 0;
  private _filtered: SelectItem[];
  private invalidateFn: () => void = () => {};

  constructor(opts: MenuOverlayOptions) {
    this.itemsFn = opts.items;
    this.maxVisible = opts.maxVisible ?? 8;
    this.theme = opts.theme ?? PLAIN_THEME;
    this._filtered = this.itemsFn("");
  }

  /** Items matching the current query (fuzzy, score-ranked). */
  get filtered(): SelectItem[] {
    return this._filtered;
  }

  /** Live-filter on query change; persist selection by value. No-op if unchanged. */
  setQuery(query: string): void {
    if (query === this.query) return;
    this.query = query;
    const all = this.itemsFn(query);
    this._filtered = query ? fuzzyFilter(all, query, (i) => i.value) : all;
    this.selectedIndex = resolveSelectionByValue(this._filtered, this.selectedValue);
    this.invalidateFn();
  }

  /** Move selection by `delta` rows (clamped); track the new selected value. */
  move(delta: number): void {
    const n = this._filtered.length;
    if (n === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + delta, n - 1));
    this.selectedValue = this._filtered[this.selectedIndex]?.value;
    this.invalidateFn();
  }

  getSelectedItem(): SelectItem | null {
    return this._filtered[this.selectedIndex] ?? null;
  }

  /** Editor wires this to the TUI's invalidate so state changes re-render. */
  setInvalidate(fn: () => void): void {
    this.invalidateFn = fn;
  }

  // --- Component interface ---
  invalidate(): void {
    this.invalidateFn();
  }
  render(width: number): string[] {
    // query:"" — items are already fuzzy-filtered; SelectList only lays them out
    return renderMenuLines({
      items: this._filtered,
      query: "",
      selectedIndex: this.selectedIndex,
      width,
      maxVisible: this.maxVisible,
      theme: this.theme,
    });
  }
}
