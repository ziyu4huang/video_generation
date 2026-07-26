/**
 * picker-trigger.test.ts — unit-tests the `extensions/picker.ts` input-trigger
 * glue (the onTerminalInput handler): opt-in gate, empty-prompt gate, trigger
 * char, char consumption, and re-arm-after-close. These are the integration
 * seams that ACCEPTANCE §B/§C previously could only verify manually.
 *
 * The handler is plain logic (no live TUI): it reads PI_PICKER, getEditorText,
 * and the trigger char, then calls setEditorComponent. We mock ctx.ui and drive
 * the captured handler directly.
 */
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import pickerExt from "../extensions/picker.ts";

type InputHandler = (data: string) => { consume?: boolean } | undefined;

/** Wire the extension against a fake pi/ctx and return a driver. */
function setup(opts: { piPicker?: string; editorText?: string } = {}) {
  process.env.PI_PICKER = opts.piPicker ?? "";
  let editorText = opts.editorText ?? "";
  let inputHandler: InputHandler | null = null;
  const setEditorComponent = mock((_f: unknown) => {});
  const setEditorText = mock((t: string) => {
    editorText = t;
  });

  const pi = {
    on: (event: string, handler: (e: unknown, ctx: unknown) => void) => {
      if (event === "session_start")
        handler(
          {},
          {
            ui: {
              onTerminalInput: (h: InputHandler) => {
                inputHandler = h;
              },
              getEditorText: () => editorText,
              setEditorText,
              setEditorComponent,
            },
          },
        );
    },
    getCommands: () => [{ name: "help", description: "show help", source: "core", sourceInfo: {} }],
  } as unknown as ExtensionAPI;

  pickerExt(pi); // registers session_start → fires immediately with the fake ctx

  return {
    send: (data: string) => inputHandler!(data),
    setEditorTextExternally: (t: string) => {
      editorText = t;
    },
    /** The factory last passed to setEditorComponent (a MenuPickerFactory). */
    lastFactory: () => setEditorComponent.mock.calls.at(-1)?.[0],
    setEditorComponent,
    setEditorText,
  };
}

test("opens the picker on `/` in an empty prompt and consumes the trigger char", () => {
  const { send, setEditorComponent } = setup({ piPicker: "1" });
  const res = send("/");
  assert.deepEqual(res, { consume: true });
  assert.equal(setEditorComponent.mock.calls.length, 1, "setEditorComponent called once");
});

test("no-op: `/` when the prompt is non-empty (don't hijack `/path` typing)", () => {
  const { send, setEditorComponent } = setup({ piPicker: "1", editorText: "abc" });
  assert.equal(send("/"), undefined);
  assert.equal(setEditorComponent.mock.calls.length, 0);
});

test("no-op: a non-`/` char never opens the picker", () => {
  const { send, setEditorComponent } = setup({ piPicker: "1" });
  assert.equal(send("a"), undefined);
  assert.equal(send("h"), undefined);
  assert.equal(setEditorComponent.mock.calls.length, 0);
});

test("inert without PI_PICKER=1 (normal `/command` usage unaffected)", () => {
  const { send, setEditorComponent } = setup({ piPicker: "" });
  assert.equal(send("/"), undefined);
  assert.equal(setEditorComponent.mock.calls.length, 0);
});

test("re-arms after close: `/` re-opens the picker following Esc (pickerActive resets)", () => {
  // Regression guard: pickerActive was never reset, so after the first open the
  // picker could never be re-opened for the rest of the session.
  const driver = setup({ piPicker: "1" });
  driver.send("/"); // open #1 → setEditorComponent receives the MenuPickerFactory
  assert.equal(driver.setEditorComponent.mock.calls.length, 1);

  // Build the real editor from the captured factory + cancel it (Esc). The
  // extension's onCancel must reset pickerActive so `/` can re-open.
  const factory = driver.lastFactory() as (
    tui: TUI,
    theme: EditorTheme,
    kb: KeybindingsManager,
  ) => { handleInput: (d: string) => void };
  const tui = {
    showOverlay: mock(() => {}),
    hideOverlay: mock(() => {}),
    invalidate: mock(() => {}),
  } as unknown as TUI;
  const theme = { selectList: {} } as unknown as EditorTheme;
  const kb = { matches: (_d: string, id: string) => id === "tui.select.cancel" } as unknown as KeybindingsManager;
  const editor = factory(tui, theme, kb);
  editor.handleInput("\u001b"); // Esc → onCancel → pickerActive = false

  // `/` again → must re-open (consume + a third setEditorComponent call:
  // open, close-restore(undefined), re-open).
  assert.deepEqual(driver.send("/"), { consume: true });
  assert.equal(driver.setEditorComponent.mock.calls.length, 3, "open, close-restore, re-open");
  assert.equal(driver.setEditorComponent.mock.calls[1][0], undefined, "close restored the default editor");
  assert.equal(typeof driver.setEditorComponent.mock.calls[2][0], "function", "re-open passed a factory");
});
