/**
 * picker.ts — slash-command consumer for the menu picker (ticket 06 tracer bullet).
 *
 * Opt-in tracer: with `PI_PICKER=1`, typing `/` in an EMPTY prompt opens the
 * menu picker (createMenuPicker) listing every slash-command (pi.getCommands),
 * fuzzy-filtered. ↓/↑ navigate; Enter fills the prompt with the command; Esc
 * cancels. Inert unless the env var is set, so it never disrupts normal
 * `/command` usage or `/path` typing.
 *
 * This is the runtime proof of the editor-driven model (tickets 04/05/06):
 * the MenuPickerEditor owns input + drives a nonCapturing SelectList overlay.
 * Manual verification: ACCEPTANCE.md §B/§C.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMenuPicker } from "../src/index.js";
import { toCommandItems } from "../src/command-items.js";

const TRIGGER = "/";

export default function (pi: ExtensionAPI): void {
  // onTerminalInput lives on ctx.ui (per-session) → register on session_start.
  pi.on("session_start", (_event, ctx) => {
    let pickerActive = false; // re-entry guard (don't open a picker over a picker)

    ctx.ui.onTerminalInput((data) => {
      // opt-in only
      if (process.env.PI_PICKER !== "1") return undefined;
      // open on the trigger char typed in an empty prompt
      if (data !== TRIGGER) return undefined;
      if (pickerActive) return undefined;
      if (ctx.ui.getEditorText() !== "") return undefined;

      pickerActive = true;
      ctx.ui.setEditorComponent(
        createMenuPicker(ctx, {
          items: () => toCommandItems(pi.getCommands()),
          // fill the prompt with the chosen command; the user presses Enter to run
          // (no public submit API — see ticket 06 / ACCEPTANCE §C note).
          onSelect: (item) => {
            ctx.ui.setEditorText(item.value);
          },
          onCancel: () => {
            /* prompt restored empty by the picker's close() */
          },
        }),
      );
      return { consume: true }; // eat the trigger char (picker starts empty)
    });
  });
}
