/**
 * trigger.ts — register the Down-at-empty-editor handler that opens the status
 * launcher panel. Registered per-session on session_start via ctx.ui.onTerminalInput.
 *
 * Decision tree (any "no" → return undefined = normal Down handling):
 *   isDownKey?  →  panel not already active?  →  editor empty (getEditorText==="")?
 *                                              →  entries non-empty?
 *   all yes ⇒ openPanel + { consume: true } (eat the Down).
 *
 * "editor empty" is the proxy for "empty + no forward-history-browse": browsing
 * input history always leaves text in the prompt, so an empty prompt means Down's
 * history-forward behaviour is a no-op anyway — safe to repurpose.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getPanelEntries, type PanelEntry } from "./presence.js";
import { createStatusPanel } from "./panel.js";

export interface TriggerCtx {
  ui: ExtensionUIContext;
}

export interface TriggerDeps {
  isDownKey: (data: string) => boolean;
  getEntries: () => PanelEntry[];
  openPanel: (ctx: TriggerCtx, entries: PanelEntry[], opts: { onDone: () => void }) => void;
}

const defaultDeps: TriggerDeps = {
  isDownKey: (data) => matchesKey(data, Key.down),
  getEntries: getPanelEntries,
  openPanel: (ctx, entries, opts) => {
    ctx.ui.setEditorComponent(createStatusPanel(ctx, entries, opts));
  },
};

/**
 * Register the launcher trigger. Returns the onTerminalInput remove-fn (for
 * session cleanup if ever needed). No-op safe: if ctx.ui has no
 * onTerminalInput, returns a no-op remover.
 */
export function registerStatusLauncherTrigger(ctx: TriggerCtx, deps: TriggerDeps = defaultDeps): () => void {
  if (typeof ctx.ui.onTerminalInput !== "function") return () => {};
  let panelActive = false;
  return ctx.ui.onTerminalInput((data: string) => {
    if (!deps.isDownKey(data)) return undefined;
    if (panelActive) return undefined;
    if (ctx.ui.getEditorText() !== "") return undefined;
    const entries = deps.getEntries();
    if (entries.length === 0) return undefined;
    panelActive = true;
    deps.openPanel(ctx, entries, { onDone: () => {
      panelActive = false;
    } });
    return { consume: true };
  });
}
