/**
 * Options-aware checkpoint UI routing (self-arc-24 t01).
 *
 * The workflow runtime hands every checkpoint() a `confirm(promptText, options)`
 * callback; before this module the tool boundary collapsed ALL kinds to a
 * yes/no `ctx.ui.confirm`. The probe (recorded in the arc-24 map) showed the
 * tool handler's ctx carries pi's full ExtensionUIContext, so the routing now
 * honors the DECLARED kind:
 *
 *   select → `ui.select`  — numbered choice list (arrow/number keys)
 *   input  → `ui.input`   — free-text dialog
 *   confirm→ `ui.confirm` — yes/no gate
 *
 * pi's ExtensionUIDialogOptions gives every widget a live-countdown `timeout`
 * and an AbortSignal (a run abort dismisses the dialog). A dismissed or timed-
 * out dialog falls back to the checkpoint's declared `default` (undefined when
 * none — the runtime journals the reply either way, and a journal entry whose
 * result is absent re-asks on resume).
 *
 * Headless/background runs never get here: the tool passes confirm=undefined
 * and the runtime takes its headless path (default / abort).
 */

import type { CheckpointOptions } from "./workflow.js";

/** Structural subset of pi's ExtensionUIDialogOptions (live-countdown timeout + abort). */
export type UiDialogOpts = { signal?: AbortSignal; timeout?: number };

/** Structural subset of pi's ExtensionUIContext that checkpoints may need. */
export interface CheckpointUiSurface {
  confirm?(title: string, message: string, opts?: UiDialogOpts): Promise<boolean>;
  select?(title: string, options: string[], opts?: UiDialogOpts): Promise<string | undefined>;
  input?(title: string, placeholder?: string, opts?: UiDialogOpts): Promise<string | undefined>;
}

/**
 * Build the runtime's confirm callback from a UI-bearing tool context, or
 * undefined when the run has no UI (headless/background — runtime takes over).
 */
export function createCheckpointConfirm(
  ui: CheckpointUiSurface | undefined,
): ((promptText: string, options: CheckpointOptions) => Promise<unknown>) | undefined {
  if (!ui) return undefined;
  return (promptText: string, options: CheckpointOptions): Promise<unknown> => {
    const dialogOpts: UiDialogOpts = { signal: options.signal, timeout: options.timeoutMs };
    if (options.kind === "select" && options.choices?.length) {
      const select = ui.select;
      if (select) {
        return select
          .call(ui, `Workflow checkpoint: ${promptText}`, options.choices, dialogOpts)
          .then((picked) => picked ?? options.default);
      }
    }
    if (options.kind === "input") {
      const input = ui.input;
      if (input) {
        return input
          .call(
            ui,
            `Workflow checkpoint: ${promptText}`,
            typeof options.default === "string" ? options.default : undefined,
            dialogOpts,
          )
          .then((text) => text ?? options.default);
      }
    }
    const uiConfirm = ui.confirm;
    if (uiConfirm) {
      return uiConfirm.call(ui, "Workflow checkpoint", promptText, dialogOpts);
    }
    return Promise.resolve(options.default ?? true);
  };
}
