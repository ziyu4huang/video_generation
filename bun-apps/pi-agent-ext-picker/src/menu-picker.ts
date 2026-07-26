/**
 * menu-picker.ts — the interactive layer: a `CustomEditor` subclass that owns
 * input and drives a nonCapturing `MenuOverlay` (SelectList) overlay.
 *
 * Architecture (tickets 04/05/06):
 *   - The editor IS the focused input surface (set via `ctx.ui.setEditorComponent`).
 *   - It shows the `MenuOverlay` as a `nonCapturing` overlay → the overlay renders
 *     but does NOT steal focus (pi-tui showOverlay skips setFocus when nonCapturing),
 *     so the editor keeps receiving typed chars → live filter.
 *   - `onChange` re-derives the query from the buffer + re-filters the overlay.
 *   - `handleInput` intercepts `tui.select.up/down/confirm/cancel` via the
 *     keybindings manager (user-configurable, ticket 05) and CONSUMES them so
 *     the Editor base doesn't also move the text cursor.
 *
 * This layer is NOT unit-testable (needs a live TUI); its render + state logic
 * live in `menu-render.ts` (tested) and its interaction is verified manually
 * (ACCEPTANCE.md §B). Keep this file thin — push logic into menu-render.ts.
 */
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, OverlayAnchor, SelectItem, TUI } from "@earendil-works/pi-tui";
import { MenuOverlay } from "./menu-render.js";

/** Minimal ctx shape the picker needs (restore the default editor on close).
 * Structurally compatible with the real ExtensionContext. */
export interface MenuPickerCtx {
  ui: {
    setEditorComponent(factory: unknown): void;
  };
}

export interface MenuPickerOptions {
  /** Items source, called with the live query (lets providers pre-narrow). */
  items: (query: string) => SelectItem[];
  /** Accept — fired on `tui.select.confirm` (Enter). */
  onSelect: (item: SelectItem, query: string) => void;
  /** Cancel — fired on `tui.select.cancel` / Esc. Buffer is retained by caller. */
  onCancel?: (query: string) => void;
  /** Visible rows in the scroll viewport. Default 8. */
  maxVisible?: number;
  /** Overlay anchor. Default "bottom-center" (claude-code drop-below-input). */
  anchor?: OverlayAnchor;
}

/** Factory signature required by `ctx.ui.setEditorComponent`. */
export type MenuPickerFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => MenuPickerEditor;

/**
 * Build a menu-picker editor factory. Pass to `ctx.ui.setEditorComponent`.
 * The editor owns input + drives a nonCapturing SelectList overlay; on
 * accept/cancel it hides the overlay and restores the default editor.
 *
 * @example
 * ctx.ui.setEditorComponent(createMenuPicker(ctx, {
 *   items: (q) => slashCommands.filter(...),
 *   onSelect: (item, query) => { ctx.ui.setEditorText(item.value); runCmd(item); },
 *   onCancel: (query) => {},
 * }));
 */
export function createMenuPicker(ctx: MenuPickerCtx, opts: MenuPickerOptions): MenuPickerFactory {
  return (tui, theme, keybindings) => new MenuPickerEditor(tui, theme, keybindings, ctx, opts);
}

export class MenuPickerEditor extends CustomEditor {
  private readonly overlay: MenuOverlay;
  private readonly kb: KeybindingsManager;
  private readonly pickerCtx: MenuPickerCtx;
  private readonly pickerOpts: MenuPickerOptions;
  private closed = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    ctx: MenuPickerCtx,
    opts: MenuPickerOptions,
  ) {
    super(tui, theme, keybindings);
    this.kb = keybindings;
    this.pickerCtx = ctx;
    this.pickerOpts = opts;

    // overlay renders with the editor's real select-list theme (colors)
    this.overlay = new MenuOverlay({
      items: opts.items,
      maxVisible: opts.maxVisible,
      theme: theme.selectList,
    });
    this.overlay.setInvalidate(() => this.tui.invalidate());

    // live filter: buffer change → re-derive query → re-filter overlay
    this.onChange = (text) => this.overlay.setQuery(text);

    // show the overlay nonCapturing → editor keeps focus (ticket 06 gate)
    this.tui.showOverlay(this.overlay, {
      nonCapturing: true,
      anchor: opts.anchor ?? "bottom-center",
    });
  }

  /** Intercept nav/accept/cancel (user-configurable keybindings, ticket 05) and
   * CONSUME them; everything else (text editing, app keybindings) → super. */
  override handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.up")) { this.overlay.move(-1); return; }
    if (this.kb.matches(data, "tui.select.down")) { this.overlay.move(1); return; }
    if (this.kb.matches(data, "tui.select.confirm")) { this.accept(); return; }
    if (this.kb.matches(data, "tui.select.cancel")) { this.cancel(); return; }
    super.handleInput(data);
  }

  private accept(): void {
    if (this.closed) return;
    const item = this.overlay.getSelectedItem();
    if (!item) return; // empty-state: Enter is a no-op (ACCEPTANCE §B)
    this.close();
    this.pickerOpts.onSelect(item, this.overlay.query);
  }

  private cancel(): void {
    if (this.closed) return;
    const query = this.overlay.query;
    this.close();
    this.pickerOpts.onCancel?.(query);
  }

  private close(): void {
    this.closed = true;
    this.tui.hideOverlay();
    this.pickerCtx.ui.setEditorComponent(undefined); // restore default editor
  }
}
