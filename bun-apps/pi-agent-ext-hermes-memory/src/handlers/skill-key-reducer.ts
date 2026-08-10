/**
 * Pure key-reducer for the skills manager modal (The Elm Architecture).
 *
 * SkillsManagerModal.handleInput used to be a ~113-line untestable key
 * dispatcher that interleaved pure state changes (cursor moves, selection
 * toggles) with imperative side-effects (async store moves, search-input
 * delegation, renders). It is now an apply-reducer-then-execute shell:
 *
 *   snapshot -> reduceSkillKey(state, key) -> { state, effects } -> apply + run
 *
 * `reduceSkillKey` is PURE and deterministic: given a serializable
 * `SkillModalState` snapshot and a raw input string it returns the next state
 * plus a list of `SkillKeyEffect`s the modal must execute. It performs no I/O
 * and touches no pi-tui objects — selection is modeled as a Set<string>, the
 * terminal row count is threaded in for paging math, and sort cycling is
 * emitted as an effect (the modal owns the row rebuild + refocus-by-skillId).
 *
 * Extracted from skills-command.ts (architecture-deepening C2 Shape A,
 * zero-behavior-change). The filter sub-panel keeps its own dispatch
 * (handleFilterInput); the reducer only routes when focusArea === "filters".
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
  MEMORY_SKILLS_KEYMAP,
  nextSortMode,
  type SkillSortMode,
} from "./skill-rows.js";
import type { SkillScope } from "../types.js";

export interface SkillModalState {
  /** Which sub-panel currently owns key routing: the filter panel, search box, or the list. */
  focusArea: "filters" | "search" | "list";
  /** True while an async move/delete is in flight (only escape is honored). */
  busy: boolean;
  /** Latched true once closeModal has run; the reducer no-ops once set. */
  closed: boolean;
  /** Non-null while a delete is awaiting y/n confirmation. */
  pendingDeleteConfirm: { skillIds: string[] } | null;
  /** Active sort mode (advanced in-state on 's'; the modal rebuilds rows on the effect). */
  sortMode: SkillSortMode;
  /** Cursor into the filtered list. */
  selectedIndex: number;
  /** Selected skill ids — the single source of truth for selection (replaces row.selected flips). */
  selectedIds: Set<string>;
  /** Current search query (threaded for snapshot completeness; mutated by the search-input effect). */
  query: string;
  /** Number of rows currently visible after filtering/search (used for clamping). */
  rowCount: number;
  /** Terminal height threaded from tui.terminal.rows (drives paging math). */
  terminalRows: number;
  /** The "Last action" lines rendered at the bottom of the modal. */
  summaryLines: string[];
  /** skillId of the row under the cursor (null when the filtered list is empty) — for space toggle. */
  currentSkillId: string | null;
  /** displayName of the row under the cursor (null when empty) — for the toggle summary. */
  currentDisplayName: string | null;
  /** skillIds of every filtered row — for select-all-Filtered. */
  filteredSkillIds: string[];
}

export type SkillKeyEffect =
  | { effect: "close" }
  | { effect: "focusSearch"; data?: string }
  | { effect: "focusList" }
  | { effect: "openFilters" }
  | { effect: "cycleSort" }
  | { effect: "move"; scope: SkillScope }
  | { effect: "promptDelete" }
  | { effect: "deleteRun"; ids: string[] }
  | { effect: "delegateSearch"; data: string }
  | { effect: "routeFilters" }
  | { effect: "requestRender" };

/** Single-char command letters that must NOT fall through to the search prefill. */
const PRINTABLE_COMMAND_LETTERS: Set<string> = new Set([
  MEMORY_SKILLS_KEYMAP.moveGlobal,
  MEMORY_SKILLS_KEYMAP.moveProject,
  MEMORY_SKILLS_KEYMAP.deleteSelected,
  MEMORY_SKILLS_KEYMAP.selectAllFiltered,
  MEMORY_SKILLS_KEYMAP.clearSelection,
  MEMORY_SKILLS_KEYMAP.openFilters,
  MEMORY_SKILLS_KEYMAP.cycleSort,
]);

function isPrintableInput(data: string): boolean {
  return data.length === 1 && data >= " " && data !== "\x7f";
}

/**
 * Pure reducer. Returns the next state and the effects the modal must execute.
 * The input `state` object is never mutated; selection ops return a fresh Set.
 */
export function reduceSkillKey(
  state: SkillModalState,
  data: string,
): { state: SkillModalState; effects: SkillKeyEffect[] } {
  // Guard: once closed, ignore everything.
  if (state.closed) {
    return { state, effects: [] };
  }

  // Guard: while busy, only escape (abort) is honored.
  if (state.busy) {
    if (matchesKey(data, Key.escape)) {
      return { state, effects: [{ effect: "close" }] };
    }
    return { state, effects: [] };
  }

  // Guard: awaiting delete confirmation.
  if (state.pendingDeleteConfirm) {
    if (data === "y" || data === "Y") {
      return {
        state: { ...state, pendingDeleteConfirm: null },
        effects: [{ effect: "deleteRun", ids: state.pendingDeleteConfirm.skillIds }],
      };
    }
    if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
      return {
        state: { ...state, pendingDeleteConfirm: null, summaryLines: ["Delete cancelled."] },
        effects: [{ effect: "requestRender" }],
      };
    }
    return { state, effects: [] };
  }

  // Route: the filter sub-panel owns its own dispatch.
  if (state.focusArea === "filters") {
    return { state, effects: [{ effect: "routeFilters" }] };
  }

  // Escape closes from either the search box or the list.
  if (matchesKey(data, Key.escape)) {
    return { state, effects: [{ effect: "close" }] };
  }

  // Search box: tab/down return focus to the list; everything else is typed.
  if (state.focusArea === "search") {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
      return { state, effects: [{ effect: "focusList" }] };
    }
    return { state, effects: [{ effect: "delegateSearch", data }] };
  }

  // ===== focusArea === "list" =====

  if (data === MEMORY_SKILLS_KEYMAP.openFilters) {
    return { state, effects: [{ effect: "openFilters" }] };
  }
  if (data === MEMORY_SKILLS_KEYMAP.cycleSort) {
    return {
      state: { ...state, sortMode: nextSortMode(state.sortMode) },
      effects: [{ effect: "cycleSort" }],
    };
  }
  if (matchesKey(data, Key.tab) || matchesKey(data, Key.slash)) {
    return { state, effects: [{ effect: "focusSearch" }] };
  }
  if (matchesKey(data, Key.up)) {
    return reduceMove(state, -1);
  }
  if (matchesKey(data, Key.down)) {
    return reduceMove(state, 1);
  }
  if (matchesKey(data, Key.pageUp)) {
    return reducePage(state, -1);
  }
  if (matchesKey(data, Key.pageDown)) {
    return reducePage(state, 1);
  }
  if (matchesKey(data, Key.home)) {
    return { state: { ...state, selectedIndex: 0 }, effects: [{ effect: "requestRender" }] };
  }
  if (matchesKey(data, Key.end)) {
    return {
      state: { ...state, selectedIndex: Math.max(0, state.rowCount - 1) },
      effects: [{ effect: "requestRender" }],
    };
  }
  if (matchesKey(data, Key.space)) {
    return reduceToggleCurrent(state);
  }
  if (data === MEMORY_SKILLS_KEYMAP.selectAllFiltered) {
    return reduceSelectAllFiltered(state);
  }
  if (data === MEMORY_SKILLS_KEYMAP.clearSelection) {
    return reduceClearSelection(state);
  }
  if (data === MEMORY_SKILLS_KEYMAP.moveGlobal) {
    return { state, effects: [{ effect: "move", scope: "global" }] };
  }
  if (data === MEMORY_SKILLS_KEYMAP.moveProject) {
    return { state, effects: [{ effect: "move", scope: "project" }] };
  }
  if (data === MEMORY_SKILLS_KEYMAP.deleteSelected) {
    return { state, effects: [{ effect: "promptDelete" }] };
  }
  if (isPrintableInput(data) && !PRINTABLE_COMMAND_LETTERS.has(data)) {
    return { state, effects: [{ effect: "focusSearch", data }] };
  }

  // Unrecognized key: no-op (no state change, no render).
  return { state, effects: [] };
}

function reduceMove(state: SkillModalState, delta: number): { state: SkillModalState; effects: SkillKeyEffect[] } {
  if (state.rowCount === 0) {
    return { state, effects: [] };
  }
  const next = Math.max(0, Math.min(state.selectedIndex + delta, state.rowCount - 1));
  return { state: { ...state, selectedIndex: next }, effects: [{ effect: "requestRender" }] };
}

function pageSizeFor(terminalRows: number): number {
  const maxVisibleRows = Math.max(6, Math.min(14, terminalRows - 22));
  return Math.max(5, maxVisibleRows - 1);
}

function reducePage(state: SkillModalState, delta: number): { state: SkillModalState; effects: SkillKeyEffect[] } {
  if (state.rowCount === 0) {
    return { state, effects: [] };
  }
  const pageSize = pageSizeFor(state.terminalRows);
  const next = Math.max(0, Math.min(state.selectedIndex + delta * pageSize, state.rowCount - 1));
  return { state: { ...state, selectedIndex: next }, effects: [{ effect: "requestRender" }] };
}

function reduceToggleCurrent(state: SkillModalState): { state: SkillModalState; effects: SkillKeyEffect[] } {
  if (state.currentSkillId === null) {
    return { state, effects: [] };
  }
  const next = new Set(state.selectedIds);
  if (next.has(state.currentSkillId)) {
    next.delete(state.currentSkillId);
  } else {
    next.add(state.currentSkillId);
  }
  const nowSelected = next.has(state.currentSkillId);
  const displayName = state.currentDisplayName ?? "";
  return {
    state: {
      ...state,
      selectedIds: next,
      summaryLines: [`${nowSelected ? "Selected" : "Cleared"} ${displayName}.`],
    },
    effects: [{ effect: "requestRender" }],
  };
}

function reduceSelectAllFiltered(state: SkillModalState): { state: SkillModalState; effects: SkillKeyEffect[] } {
  const next = new Set(state.selectedIds);
  for (const id of state.filteredSkillIds) {
    next.add(id);
  }
  const count = state.filteredSkillIds.length;
  return {
    state: {
      ...state,
      selectedIds: next,
      summaryLines: [`Selected ${count} visible skill${count === 1 ? "" : "s"}.`],
    },
    effects: [{ effect: "requestRender" }],
  };
}

function reduceClearSelection(state: SkillModalState): { state: SkillModalState; effects: SkillKeyEffect[] } {
  return {
    state: { ...state, selectedIds: new Set(), summaryLines: ["Cleared all selections."] },
    effects: [{ effect: "requestRender" }],
  };
}
