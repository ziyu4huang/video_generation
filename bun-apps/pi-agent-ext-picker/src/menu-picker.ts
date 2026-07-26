/**
 * menu-picker.ts — the interactive menu component for the pi-agent TUI.
 *
 * claude-code-style: type-to-filter (fuzzy) + ↑/↓ navigate + Enter select.
 * Built on pi-tui's `SelectList` (owns layout/scroll/truncate) + `fuzzyFilter`.
 *
 * Architecture (tickets 04/05/06):
 *   - The full `createMenuPicker` is a `CustomEditor` subclass that owns input
 *     + drives a `nonCapturing` SelectList OVERLAY (ticket 06 gate: a nonCapturing
 *     overlay renders but does NOT steal focus, so the editor keeps receiving
 *     typed chars → live filter; it intercepts ↑/↓ to move the selection).
 *   - `renderMenuLines` is the deterministic, TUI-runtime-free render CORE —
 *     extracted so it is unit-testable (render-snapshot, ticket 07) without a
 *     live terminal. The editor/overlay layer composes it.
 */
import { SelectList, fuzzyFilter, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui";

/** Plain (no-ANSI) theme — deterministic output for render-snapshot tests + tool
 * text. The real themed variant is constructed by the editor/overlay layer. */
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
  /** The current query string (fuzzy-matched against item.value). */
  query: string;
  /** Selection index into the FILTERED list (clamped). Default 0. */
  selectedIndex?: number;
  /** Render width in columns. Default 60. */
  width?: number;
  /** Max visible rows before scroll. Default 8. */
  maxVisible?: number;
  /** Theme. Defaults to PLAIN_THEME (deterministic). */
  theme?: SelectListTheme;
}

/**
 * Render the menu lines for a given query + selection — the testable core.
 *
 * Filtering is FUZZY (ticket 05 contract) via `fuzzyFilter` (score-ranked);
 * SelectList's own prefix-match filter is bypassed (pre-filtered items are fed
 * directly, so SelectList only owns layout/scroll/truncate). Selection is
 * clamped to the filtered list.
 */
export function renderMenuLines(opts: RenderMenuOpts): string[] {
  const {
    items,
    query,
    selectedIndex = 0,
    width = 60,
    maxVisible = 8,
    theme = PLAIN_THEME,
  } = opts;
  const filtered = query ? fuzzyFilter(items, query, (i) => i.value) : items;
  const list = new SelectList(filtered, maxVisible, theme);
  if (filtered.length > 0) {
    list.setSelectedIndex(Math.min(selectedIndex, filtered.length - 1));
  }
  return list.render(width);
}
