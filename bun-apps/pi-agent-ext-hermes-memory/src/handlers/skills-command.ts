/**
 * Skills command — /memory-skills opens an interactive skills manager.
 *
 * The pure row-model + codec helpers live in ./skill-rows.js and the batch
 * SkillStore operations (move / delete / confirm) live in ./skill-batch-ops.js.
 * This module retains the SkillsManagerModal view and the command registration.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SkillStore } from "../store/skill-store.js";
import type { SkillIndex, SkillScope } from "../types.js";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_SKILL_FILTERS,
  buildUnifiedSkillRows,
  cloneFilters,
  collectLoadedSkillsFromCommands,
  ensureValidFilters,
  filterSkillRows,
  filtersLabel,
  formatSkillsList,
  getSelectedSkillIds,
  matchesCategoryFilter,
  sortModeLabel,
  type LoadedSkillRow,
  type SkillCategoryFilters,
  type SkillCommandInfo,
  type SkillModalRow,
  type SkillSortMode,
} from "./skill-rows.js";
import {
  deleteSelectedSkills,
  moveSelectedSkills,
  type SkillBatchActionResult,
} from "./skill-batch-ops.js";
import {
  reduceSkillKey,
  type SkillKeyEffect,
  type SkillModalState,
} from "./skill-key-reducer.js";

interface SkillsManagerCallbacks {
  moveSelected: (scope: SkillScope, skillIds: string[]) => Promise<SkillBatchActionResult>;
  deleteSelected: (skillIds: string[]) => Promise<SkillBatchActionResult>;
  close: () => void;
  projectName: string | null;
}

export class SkillsManagerModal implements Focusable {
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncSearchFocus();
  }

  private readonly searchInput = new Input();
  private managedSkills: SkillIndex[];
  private readonly loadedSkills: LoadedSkillRow[];
  private rows: SkillModalRow[];
  private selectedIndex = 0;
  private query = "";
  private focusArea: "search" | "list" | "filters" = "list";
  private busy = false;
  private closed = false;
  private pendingDeleteConfirm: { skillIds: string[] } | null = null;
  private activeFilters: SkillCategoryFilters = { ...DEFAULT_SKILL_FILTERS };
  private pendingFilters: SkillCategoryFilters | null = null;
  private filterCursor = 0;
  private sortMode: SkillSortMode = "updated";
  private summaryLines: string[] = [
    "Select skills with space, then move with g/p or delete with d. Press s to change sort and f for filters.",
  ];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    initialRows: SkillModalRow[],
    private readonly callbacks: SkillsManagerCallbacks,
    options?: {
      managedSkills?: SkillIndex[];
      loadedSkills?: LoadedSkillRow[];
    },
  ) {
    const selectedSkillIds = new Set(initialRows.filter((row) => row.selected).map((row) => row.skillId));

    this.loadedSkills = options?.loadedSkills
      ?? initialRows
        .filter((row) => row.category === "E")
        .map((row) => ({
          name: row.name,
          displayName: row.displayName,
          description: row.description,
          path: row.path,
          displayPath: row.displayPath,
        }));

    this.managedSkills = options?.managedSkills
      ?? initialRows
        .filter((row) => row.category !== "E" && row.scope)
        .map((row) => ({
          skillId: row.skillId,
          scope: row.scope!,
          fileName: path.basename(row.path),
          path: row.path,
          projectName: row.projectName,
          name: row.name,
          displayName: row.displayName,
          description: row.description,
          created: row.created ?? "",
          updated: row.updated ?? "",
        }));

    this.rows = buildUnifiedSkillRows(this.managedSkills, this.loadedSkills, selectedSkillIds, this.sortMode);
    this.syncSearchFocus();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  private get filteredRows(): SkillModalRow[] {
    const categoryFiltered = this.rows.filter((row) => matchesCategoryFilter(row, this.activeFilters));
    return filterSkillRows(categoryFiltered, this.query);
  }

  private getCurrentRow(): SkillModalRow | null {
    const rows = this.filteredRows;
    if (rows.length === 0) return null;
    return rows[Math.min(this.selectedIndex, rows.length - 1)] ?? null;
  }

  private getSelectedRows(): SkillModalRow[] {
    return this.rows.filter((row) => row.selected);
  }

  private getSelectedIds(): string[] {
    return getSelectedSkillIds(this.rows);
  }

  private getFilterOptions(): Array<{ key: keyof SkillCategoryFilters; label: string }> {
    return [
      { key: "global", label: "Global [G]" },
      { key: "project", label: "Project [P]" },
      { key: "external", label: "External [E] (read-only)" },
    ];
  }

  private syncSearchFocus(): void {
    this.searchInput.focused = this.focused && this.focusArea === "search";
  }

  private syncQueryFromInput(): void {
    this.query = this.searchInput.getValue();
    const rows = this.filteredRows;
    if (rows.length === 0) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
    }
  }

  private setFocusArea(area: "search" | "list" | "filters"): void {
    this.focusArea = area;
    this.syncSearchFocus();
    this.tui.requestRender();
  }

  private setRows(managedSkills: SkillIndex[], retainSelectedSkillIds: string[] = [], focusSkillId?: string): void {
    this.managedSkills = managedSkills;
    this.rows = buildUnifiedSkillRows(this.managedSkills, this.loadedSkills, new Set(retainSelectedSkillIds), this.sortMode);
    this.syncQueryFromInput();

    const rows = this.filteredRows;
    if (rows.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    if (focusSkillId) {
      const focusIndex = rows.findIndex((row) => row.skillId === focusSkillId);
      if (focusIndex >= 0) {
        this.selectedIndex = focusIndex;
        return;
      }
    }

    this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
  }

  /**
   * cycleSort effect handler. The reducer already advanced this.sortMode
   * (applied via applySkillModalState); this rebuilds the unified rows under the
   * new mode, refocuses by the pre-rebuild cursor's skillId, sets the summary,
   * and renders. The reducer never touches rows.
   */
  private rebuildAfterSortCycle(): void {
    const selectedIds = this.getSelectedIds();
    const currentSkillId = this.getCurrentRow()?.skillId;
    this.rows = buildUnifiedSkillRows(
      this.managedSkills,
      this.loadedSkills,
      new Set(selectedIds),
      this.sortMode,
    );
    this.syncQueryFromInput();

    const rows = this.filteredRows;
    if (rows.length === 0) {
      this.selectedIndex = 0;
    } else if (currentSkillId) {
      const focusIndex = rows.findIndex((row) => row.skillId === currentSkillId);
      this.selectedIndex = focusIndex >= 0
        ? focusIndex
        : Math.min(this.selectedIndex, rows.length - 1);
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
    }

    this.summaryLines = [`Sort mode: ${sortModeLabel(this.sortMode)}.`];
    this.tui.requestRender();
  }

  private appendExternalReadOnlySummary(
    result: SkillBatchActionResult,
    blockedExternalRows: SkillModalRow[],
    verb: "move" | "delete",
  ): SkillBatchActionResult {
    if (blockedExternalRows.length === 0) return result;

    const blockedIds = blockedExternalRows.map((row) => row.skillId);
    const retainSet = new Set([...(result.retainSelectedSkillIds || []), ...blockedIds]);
    const focusSkillId = result.focusSkillId || blockedIds[0];
    const blockedLabel = blockedExternalRows.length === 1
      ? `Blocked 1 external skill: ${blockedExternalRows[0]!.displayName} is read-only.`
      : `Blocked ${blockedExternalRows.length} external skills: read-only (${verb} unavailable).`;

    return {
      ...result,
      summaryLines: [...result.summaryLines, blockedLabel],
      retainSelectedSkillIds: Array.from(retainSet),
      focusSkillId,
    };
  }

  private prepareMutableSelection(verb: "move" | "delete"):
    | { proceed: false }
    | { proceed: true; mutableIds: string[]; blockedExternalRows: SkillModalRow[] } {
    const selectedRows = this.getSelectedRows();
    if (selectedRows.length === 0) {
      this.summaryLines = ["Select one or more skills first."];
      this.tui.requestRender();
      return { proceed: false };
    }

    const mutableRows = selectedRows.filter((row) => row.mutable);
    const blockedExternalRows = selectedRows.filter((row) => !row.mutable);

    if (mutableRows.length === 0 && blockedExternalRows.length > 0) {
      this.summaryLines = [
        `Blocked ${blockedExternalRows.length} external skill${blockedExternalRows.length === 1 ? "" : "s"}: read-only (${verb} unavailable).`,
      ];
      this.tui.requestRender();
      return { proceed: false };
    }

    return {
      proceed: true,
      mutableIds: mutableRows.map((row) => row.skillId),
      blockedExternalRows,
    };
  }

  private async runMove(targetScope: SkillScope): Promise<void> {
    const selection = this.prepareMutableSelection("move");
    if (!selection.proceed) return;

    const action = this.callbacks.moveSelected(targetScope, selection.mutableIds)
      .then((result) => this.appendExternalReadOnlySummary(result, selection.blockedExternalRows, "move"));

    await this.runAsyncAction(action);
  }

  private promptDelete(): void {
    const selection = this.prepareMutableSelection("delete");
    if (!selection.proceed) return;

    this.pendingDeleteConfirm = { skillIds: selection.mutableIds };
    const blockedCount = selection.blockedExternalRows.length;
    this.summaryLines = [
      `Delete ${selection.mutableIds.length} selected skill${selection.mutableIds.length === 1 ? "" : "s"}? Press y to confirm or n to cancel.${blockedCount > 0 ? ` (${blockedCount} external read-only item${blockedCount === 1 ? "" : "s"} will be skipped)` : ""}`,
    ];
    this.tui.requestRender();
  }

  private async runDeleteConfirmed(skillIds: string[]): Promise<void> {
    const blockedExternalRows = this.rows.filter((row) => row.selected && !row.mutable);
    const action = this.callbacks.deleteSelected(skillIds)
      .then((result) => this.appendExternalReadOnlySummary(result, blockedExternalRows, "delete"));

    await this.runAsyncAction(action);
  }

  private closeModal(): void {
    if (this.closed) return;
    this.closed = true;
    this.callbacks.close();
  }

  private openFilterPanel(): void {
    this.pendingFilters = cloneFilters(this.activeFilters);
    this.filterCursor = 0;
    this.setFocusArea("filters");
    this.summaryLines = ["Filter panel open: space toggle · enter apply · esc cancel."];
    this.tui.requestRender();
  }

  private applyFilterPanel(): void {
    const candidate = ensureValidFilters(this.pendingFilters ? cloneFilters(this.pendingFilters) : cloneFilters(this.activeFilters));
    const wasAllOff = this.pendingFilters
      && !this.pendingFilters.global
      && !this.pendingFilters.project
      && !this.pendingFilters.external;

    this.activeFilters = candidate;
    this.pendingFilters = null;
    this.syncQueryFromInput();
    this.setFocusArea("list");
    this.summaryLines = [
      wasAllOff
        ? "All categories were disabled; restored filters to [G] [P] [E]."
        : `Applied filters: ${filtersLabel(this.activeFilters)}`,
    ];
    this.tui.requestRender();
  }

  private cancelFilterPanel(): void {
    this.pendingFilters = null;
    this.setFocusArea("list");
    this.summaryLines = ["Filter changes cancelled."];
    this.tui.requestRender();
  }

  private handleFilterInput(data: string): void {
    const options = this.getFilterOptions();
    const draft = this.pendingFilters ?? cloneFilters(this.activeFilters);
    this.pendingFilters = draft;

    if (matchesKey(data, Key.escape)) {
      this.cancelFilterPanel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.filterCursor = Math.max(0, this.filterCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.filterCursor = Math.min(options.length - 1, this.filterCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.space)) {
      const option = options[this.filterCursor];
      if (option) {
        draft[option.key] = !draft[option.key];
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.applyFilterPanel();
    }
  }

  private async runAsyncAction(action: Promise<SkillBatchActionResult>): Promise<void> {
    if (this.closed) return;

    this.busy = true;
    this.summaryLines = ["Applying skill changes…"];
    this.tui.requestRender();

    try {
      const result = await action;
      if (this.closed) return;
      this.setRows(result.skills, result.retainSelectedSkillIds, result.focusSkillId);
      this.summaryLines = result.summaryLines;
    } catch (error) {
      if (!this.closed) {
        this.summaryLines = [error instanceof Error ? error.message : String(error)];
      }
    } finally {
      this.busy = false;
      if (!this.closed) {
        this.tui.requestRender();
      }
    }
  }

  private getMaxVisibleRows(): number {
    return Math.max(6, Math.min(14, this.tui.terminal.rows - 22));
  }

  private focusSearchWithOptionalInput(data?: string): void {
    this.setFocusArea("search");
    if (data) {
      this.searchInput.handleInput(data);
      this.syncQueryFromInput();
      this.tui.requestRender();
    }
  }

  /**
   * Key dispatcher: snapshot the modal into a serializable reducer state, run
   * the pure reduceSkillKey, apply the state delta back, then execute each
   * emitted side-effect. All branch logic lives in the (unit-tested) reducer;
   * this method is just the apply-reducer-then-execute shell.
   */
  handleInput(data: string): void {
    const snapshot = this.snapshotSkillModalState();
    const { state, effects } = reduceSkillKey(snapshot, data);
    this.applySkillModalState(state);
    for (const effect of effects) {
      this.executeSkillKeyEffect(effect, data);
    }
  }

  /** Snapshot the modal's mutable fields into a serializable reducer state. */
  private snapshotSkillModalState(): SkillModalState {
    const filtered = this.filteredRows;
    const currentRow = this.getCurrentRow();
    return {
      focusArea: this.focusArea,
      busy: this.busy,
      closed: this.closed,
      pendingDeleteConfirm: this.pendingDeleteConfirm,
      sortMode: this.sortMode,
      selectedIndex: this.selectedIndex,
      selectedIds: new Set(this.getSelectedIds()),
      query: this.query,
      rowCount: filtered.length,
      terminalRows: this.tui.terminal.rows,
      summaryLines: this.summaryLines,
      currentSkillId: currentRow?.skillId ?? null,
      currentDisplayName: currentRow?.displayName ?? null,
      filteredSkillIds: filtered.map((row) => row.skillId),
    };
  }

  /** Apply the reducer's state delta back onto the modal's fields. */
  private applySkillModalState(state: SkillModalState): void {
    this.focusArea = state.focusArea;
    this.selectedIndex = state.selectedIndex;
    this.pendingDeleteConfirm = state.pendingDeleteConfirm;
    this.sortMode = state.sortMode;
    this.query = state.query;
    this.summaryLines = state.summaryLines;
    for (const row of this.rows) {
      row.selected = state.selectedIds.has(row.skillId);
    }
  }

  /** Execute a side-effect emitted by the reducer. */
  private executeSkillKeyEffect(effect: SkillKeyEffect, data: string): void {
    switch (effect.effect) {
      case "close":
        this.closeModal();
        break;
      case "focusSearch":
        this.focusSearchWithOptionalInput(effect.data);
        break;
      case "focusList":
        this.setFocusArea("list");
        break;
      case "openFilters":
        this.openFilterPanel();
        break;
      case "cycleSort":
        this.rebuildAfterSortCycle();
        break;
      case "move":
        void this.runMove(effect.scope);
        break;
      case "promptDelete":
        this.promptDelete();
        break;
      case "deleteRun":
        void this.runDeleteConfirmed(effect.ids);
        break;
      case "delegateSearch":
        this.searchInput.handleInput(data);
        this.syncQueryFromInput();
        this.tui.requestRender();
        break;
      case "routeFilters":
        this.handleFilterInput(data);
        break;
      case "requestRender":
        this.tui.requestRender();
        break;
    }
  }

  private renderFramedLine(content: string, width: number): string {
    const innerWidth = Math.max(10, width - 4);
    const padded = truncateToWidth(content, innerWidth, "");
    const spaces = Math.max(0, innerWidth - visibleWidth(padded));
    return `${this.theme.fg("borderAccent", "│")} ${padded}${" ".repeat(spaces)} ${this.theme.fg("borderAccent", "│")}`;
  }

  private renderWrappedSection(lines: string[], width: number): string[] {
    const rendered: string[] = [];
    const innerWidth = Math.max(10, width - 4);
    for (const line of lines) {
      const wrapped = wrapTextWithAnsi(line, innerWidth);
      if (wrapped.length === 0) {
        rendered.push(this.renderFramedLine("", width));
        continue;
      }
      for (const part of wrapped) {
        rendered.push(this.renderFramedLine(part, width));
      }
    }
    return rendered;
  }

  private renderFilterPanel(width: number): string[] {
    const panelWidth = Math.max(34, Math.min(width - 10, 58));
    const top = this.theme.fg("borderAccent", `┌${"─".repeat(Math.max(1, panelWidth - 2))}┐`);
    const bottom = this.theme.fg("borderAccent", `└${"─".repeat(Math.max(1, panelWidth - 2))}┘`);
    const lines: string[] = [top];

    lines.push(this.renderFramedLine(this.theme.fg("accent", this.theme.bold("Filters")), panelWidth));
    lines.push(this.renderFramedLine(this.theme.fg("dim", "Space toggle · Enter apply · Esc cancel"), panelWidth));
    lines.push(this.renderFramedLine("", panelWidth));

    const draft = this.pendingFilters ?? this.activeFilters;
    const options = this.getFilterOptions();
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!;
      const checked = draft[option.key] ? "[x]" : "[ ]";
      const cursor = i === this.filterCursor ? this.theme.fg("accent", "›") : " ";
      const text = `${cursor} ${checked} ${option.label}`;
      const rendered = i === this.filterCursor
        ? this.theme.bg("selectedBg", truncateToWidth(text, Math.max(10, panelWidth - 4), ""))
        : truncateToWidth(text, Math.max(10, panelWidth - 4), "");
      lines.push(this.renderFramedLine(rendered, panelWidth));
    }

    lines.push(this.renderFramedLine("", panelWidth));
    lines.push(this.renderFramedLine(this.theme.fg("dim", `Draft: ${filtersLabel(draft)}`), panelWidth));
    lines.push(bottom);
    return lines;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(60, width);
    const top = this.theme.fg("borderAccent", `┌${"─".repeat(Math.max(1, safeWidth - 2))}┐`);
    const bottom = this.theme.fg("borderAccent", `└${"─".repeat(Math.max(1, safeWidth - 2))}┘`);
    const lines: string[] = [top];

    const projectName = this.callbacks.projectName ? ` · project: ${this.callbacks.projectName}` : "";
    const title = this.theme.fg("accent", this.theme.bold(`🧠 Procedural Skills${projectName}`));
    lines.push(this.renderFramedLine(title, safeWidth));

    const searchHint = this.focusArea === "search"
      ? this.theme.fg("accent", "search")
      : this.theme.fg("dim", "search");
    const searchLine = this.searchInput.render(Math.max(10, safeWidth - 17))[0] ?? "";
    lines.push(this.renderFramedLine(`${searchHint}: ${searchLine}`, safeWidth));

    const filteredRows = this.filteredRows;
    const selectedCount = this.getSelectedIds().length;
    lines.push(this.renderFramedLine(
      this.theme.fg(
        "dim",
        `${filteredRows.length} visible · ${this.rows.length} total · ${selectedCount} selected · sort: ${sortModeLabel(this.sortMode)}${this.busy ? " · working…" : ""}`,
      ),
      safeWidth,
    ));

    lines.push(this.renderFramedLine(this.theme.fg("dim", `Legend: [G] global · [P] project · [E] external (read-only) · filters: ${filtersLabel(this.activeFilters)}`), safeWidth));
    lines.push(this.renderFramedLine("", safeWidth));

    if (filteredRows.length === 0) {
      const emptyMessage = this.rows.length === 0 ? "No skills found yet." : "No skills match the current filters/search.";
      lines.push(this.renderFramedLine(this.theme.fg("warning", emptyMessage), safeWidth));
      lines.push(this.renderFramedLine("", safeWidth));
    } else {
      const maxVisible = this.getMaxVisibleRows();
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), filteredRows.length - maxVisible));
      const end = Math.min(filteredRows.length, start + maxVisible);
      const visibleRows = filteredRows.slice(start, end);

      for (let i = 0; i < visibleRows.length; i++) {
        const row = visibleRows[i]!;
        const absoluteIndex = start + i;
        const cursor = absoluteIndex === this.selectedIndex ? this.theme.fg("accent", "›") : " ";
        const check = row.selected ? this.theme.fg("accent", "[x]") : this.theme.fg("dim", "[ ]");
        const category = row.category === "G"
          ? this.theme.fg("accent", "[G]")
          : row.category === "P"
            ? this.theme.fg("warning", "[P]")
            : this.theme.fg("dim", "[E]");

        const baseText = `${cursor} ${check} ${category} ${row.displayName} (${row.displayPath})`;
        const lineText = absoluteIndex === this.selectedIndex
          ? this.theme.bg("selectedBg", truncateToWidth(baseText, Math.max(10, safeWidth - 4), ""))
          : truncateToWidth(baseText, Math.max(10, safeWidth - 4), "");
        lines.push(this.renderFramedLine(lineText, safeWidth));
      }

      if (start > 0 || end < filteredRows.length) {
        lines.push(this.renderFramedLine(this.theme.fg("dim", `Showing ${start + 1}-${end} of ${filteredRows.length}`), safeWidth));
      }

      lines.push(this.renderFramedLine("", safeWidth));
      const currentRow = this.getCurrentRow();
      if (currentRow) {
        const scopeLabel = currentRow.category === "E"
          ? "external (read-only)"
          : currentRow.scope === "project"
            ? "project"
            : "global";
        lines.push(this.renderFramedLine(this.theme.fg("accent", `Focused: ${currentRow.displayName} · ${scopeLabel}`), safeWidth));
        lines.push(...this.renderWrappedSection([
          currentRow.description || "(no description)",
          this.theme.fg("dim", currentRow.skillId),
          this.theme.fg("dim", currentRow.displayPath),
        ], safeWidth));
      }
    }

    lines.push(this.renderFramedLine("", safeWidth));
    lines.push(this.renderFramedLine(this.theme.fg("accent", "Last action"), safeWidth));
    lines.push(...this.renderWrappedSection(this.summaryLines, safeWidth));
    lines.push(this.renderFramedLine("", safeWidth));

    const help = this.pendingDeleteConfirm
      ? "Confirm delete: y yes · n no · esc cancel"
      : this.callbacks.projectName
        ? "↑↓ move · space select · / search · s sort · f filters · tab switch · g global · p project · d delete · a all · n none · esc close"
        : "↑↓ move · space select · / search · s sort · f filters · tab switch · g global · p project (disabled) · d delete · a all · n none · esc close";
    lines.push(this.renderFramedLine(this.theme.fg("dim", help), safeWidth));

    if (this.focusArea === "filters") {
      lines.push(this.renderFramedLine("", safeWidth));
      for (const panelLine of this.renderFilterPanel(Math.min(64, safeWidth - 6))) {
        lines.push(this.renderFramedLine(panelLine, safeWidth));
      }
    }

    lines.push(bottom);
    return lines;
  }
}

export function registerSkillsCommand(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerCommand("memory-skills", {
    description: "Manage global, active-project, and loaded external procedural skills",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const getSkillCommands = (): SkillCommandInfo[] => {
        const readCommands = (owner: unknown): SkillCommandInfo[] | null => {
          try {
            const getter = (owner as { getCommands?: () => unknown })?.getCommands;
            if (typeof getter !== "function") return null;
            const commands = getter.call(owner);
            return Array.isArray(commands) ? commands as SkillCommandInfo[] : [];
          } catch {
            return null;
          }
        };

        return readCommands(pi)
          ?? readCommands(ctx)
          ?? [];
      };

      const managedSkills = await store.loadIndex();
      const loadedSkills = collectLoadedSkillsFromCommands(getSkillCommands());
      const initialRows = buildUnifiedSkillRows(managedSkills, loadedSkills);
      const projectName = store.getProjectName();

      if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
        ctx.ui.notify(formatSkillsList(initialRows, projectName), "info");
        return;
      }

      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => new SkillsManagerModal(
            tui,
            theme,
            initialRows,
            {
              moveSelected: (scope, skillIds) => moveSelectedSkills(store, skillIds, scope),
              deleteSelected: (skillIds) => deleteSelectedSkills(store, skillIds),
              close: () => done(undefined),
              projectName,
            },
            {
              managedSkills,
              loadedSkills,
            },
          ),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "92%",
              minWidth: 76,
              maxHeight: "88%",
              margin: 1,
            },
          },
        );
      } catch {
        const latestManagedSkills = await store.loadIndex();
        const latestRows = buildUnifiedSkillRows(
          latestManagedSkills,
          collectLoadedSkillsFromCommands(getSkillCommands()),
        );
        ctx.ui.notify(
          "Interactive skills manager unavailable in this runtime; showing read-only list fallback.",
          "warning",
        );
        ctx.ui.notify(formatSkillsList(latestRows, projectName), "info");
      }
    },
  });
}
