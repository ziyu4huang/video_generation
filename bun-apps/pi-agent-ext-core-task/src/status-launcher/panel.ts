/**
 * panel.ts — the selector panel: a CustomEditor that owns input and drives a
 * nonCapturing SelectList overlay of the active status elements. ↓/↑ navigate,
 * Enter runs the selected command (autoSubmit via onSubmit), Esc cancels.
 *
 * Mirrors pi-agent-ext-picker's MenuPickerEditor but FIXED-LIST (no live
 * filter — the launcher lists ≤3 elements). Built only from pi-tui +
 * pi-coding-agent primitives (no cross-ext import — repo convention).
 */
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { SelectList, type Component, type EditorTheme, type OverlayAnchor, type SelectItem, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import type { PanelEntry } from "./presence.js";
import { createGuardedInvalidate } from "./guarded-invalidate.js";

/** Identity theme for tests / plain rendering (parity with picker's PLAIN_THEME). */
const PLAIN_THEME: SelectListTheme = {
  selectedPrefix: (t) => t,
  selectedText: (t) => t,
  description: (t) => t,
  scrollInfo: (t) => t,
  noMatch: (t) => t,
};

/** Minimal ctx shape (structurally compatible with ExtensionUIContext). */
export interface StatusPanelCtx {
  ui: { setEditorComponent(factory: unknown): void };
}

export interface StatusPanelOptions {
  /** Re-arm the trigger after the panel closes (accept or cancel). */
  onDone: () => void;
}

/** Factory signature required by ctx.ui.setEditorComponent. */
export type StatusPanelFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => StatusPanelEditor;

/** Fixed-list overlay: holds selection state; renders via SelectList. */
export class StatusPanelOverlay implements Component {
  private readonly items: SelectItem[];
  private readonly maxVisible: number;
  private readonly theme: SelectListTheme;
  private selectedIndex = 0;
  private invalidateFn: () => void = () => {};

  constructor(opts: { items: SelectItem[]; maxVisible?: number; theme?: SelectListTheme }) {
    this.items = opts.items;
    this.maxVisible = opts.maxVisible ?? 8;
    this.theme = opts.theme ?? PLAIN_THEME;
  }

  move(delta: number): void {
    const n = this.items.length;
    if (n === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + delta, n - 1));
    this.invalidateFn();
  }

  getSelectedItem(): SelectItem | null {
    return this.items[this.selectedIndex] ?? null;
  }

  setInvalidate(fn: () => void): void {
    this.invalidateFn = fn;
  }
  /**
   * Component contract: a TUI→component cache-bust notification (theme change
   * / re-render-from-scratch). Must NOT request a render — the editor wires
   * `setInvalidate` to `tui.invalidate()`, and `TUI.invalidate()` propagates
   * back to every overlay's `invalidate()`, so calling `invalidateFn` here would
   * re-enter `tui.invalidate()` and recurse until "Maximum call stack size
   * exceeded". Render requests happen via `move()`→`invalidateFn`, and the
   * input loop's post-`handleInput` `requestRender()` drives the actual render.
   * This overlay is stateless (`render()` rebuilds the SelectList fresh), so
   * there is no cached state to bust.
   */
  invalidate(): void {
    // intentionally empty — no cached rendering state
  }
  render(width: number): string[] {
    const list = new SelectList(this.items, this.maxVisible, this.theme);
    if (this.items.length > 0) list.setSelectedIndex(this.selectedIndex);
    return list.render(width);
  }
}

export function createStatusPanel(ctx: StatusPanelCtx, entries: PanelEntry[], opts: StatusPanelOptions): StatusPanelFactory {
  const items: SelectItem[] = entries.map((e) => ({ value: e.command, label: e.label }));
  return (tui, theme, keybindings) => new StatusPanelEditor(tui, theme, keybindings, ctx, items, theme.selectList, opts);
}

export class StatusPanelEditor extends CustomEditor {
  private readonly kb: KeybindingsManager;
  private readonly panelCtx: StatusPanelCtx;
  private readonly panelOpts: StatusPanelOptions;
  private readonly overlay: StatusPanelOverlay;
  private closed = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    ctx: StatusPanelCtx,
    items: SelectItem[],
    selectTheme: SelectListTheme,
    opts: StatusPanelOptions,
  ) {
    super(tui, theme, keybindings);
    this.kb = keybindings;
    this.panelCtx = ctx;
    this.panelOpts = opts;
    this.overlay = new StatusPanelOverlay({ items, theme: selectTheme });
    // Guarded: only the first (non-reentrant) call propagates to tui.invalidate().
    // Defense-in-depth on top of the no-op invalidate() — see guarded-invalidate.ts.
    this.overlay.setInvalidate(createGuardedInvalidate(this.tui));
    this.tui.showOverlay(this.overlay, { nonCapturing: true, anchor: "bottom-center" as OverlayAnchor });
  }

  override handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.up")) {
      this.overlay.move(-1);
      return;
    }
    if (this.kb.matches(data, "tui.select.down")) {
      this.overlay.move(1);
      return;
    }
    if (this.kb.matches(data, "tui.select.confirm")) {
      this.accept();
      return;
    }
    if (this.kb.matches(data, "tui.select.cancel")) {
      this.cancel();
      return;
    }
    super.handleInput(data);
  }

  private accept(): void {
    if (this.closed) return;
    const item = this.overlay.getSelectedItem();
    if (!item) return; // empty list (shouldn't happen — trigger guards) → no-op
    this.close();
    this.panelOpts.onDone();
    // auto-run: onSubmit is the slash-dispatch fn wired by setCustomEditorComponent.
    this.onSubmit?.(item.value);
  }

  private cancel(): void {
    if (this.closed) return;
    this.close();
    this.panelOpts.onDone();
  }

  private close(): void {
    this.closed = true;
    this.tui.hideOverlay();
    this.panelCtx.ui.setEditorComponent(undefined); // restore default editor
  }
}
