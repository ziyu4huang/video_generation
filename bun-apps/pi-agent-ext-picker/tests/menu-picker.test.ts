/**
 * menu-picker.test.ts — exercises MenuPickerEditor.handleInput key routing
 * (the interactive glue ACCEPTANCE §B could previously only verify by hand).
 *
 * We construct a REAL MenuPickerEditor against a mock tui/theme/keybindings and
 * drive handleInput with the byte sequences a terminal sends for ↓/↑/Enter/Esc.
 * The mock keybindings maps those bytes to the `tui.select.*` ids (exactly what
 * the real KeybindingsManager.matches does), so this tests the editor's routing
 * + accept/cancel/close logic — not pi-tui's rendering.
 */
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, SelectItem, TUI } from "@earendil-works/pi-tui";
import { createMenuPicker } from "../src/index.js";

const ITEMS: SelectItem[] = [
  { value: "/alpha", label: "alpha" },
  { value: "/beta", label: "beta" },
  { value: "/gamma", label: "gamma" },
];

/** terminal byte → keybinding id (mirrors the real KeybindingsManager). */
const DATA_ID: Record<string, string> = {
  "\u001b[B": "tui.select.down",
  "\u001b[A": "tui.select.up",
  "\r": "tui.select.confirm",
  "\u001b": "tui.select.cancel",
};

interface EditorHandle {
  editor: ReturnType<ReturnType<typeof createMenuPicker>>;
  tui: { showOverlay: ReturnType<typeof mock>; hideOverlay: ReturnType<typeof mock>; invalidate: ReturnType<typeof mock> };
  setEditorComponent: ReturnType<typeof mock>;
  onSelect: ReturnType<typeof mock>;
  onCancel: ReturnType<typeof mock>;
}

function makeEditor(opts: { items?: SelectItem[]; onSelect?: (i: SelectItem, q: string) => void; onCancel?: (q: string) => void; autoSubmit?: boolean } = {}): EditorHandle {
  const items = opts.items ?? ITEMS;
  const onSelect = mock(opts.onSelect ?? (() => {}));
  const onCancel = mock(opts.onCancel ?? (() => {}));
  const setEditorComponent = mock((_f: unknown) => {});
  const tui = {
    showOverlay: mock(() => {}),
    hideOverlay: mock(() => {}),
    invalidate: mock(() => {}),
  };
  const theme = { selectList: {} } as unknown as EditorTheme;
  const kb = { matches: (data: string, id: string) => DATA_ID[data] === id } as unknown as KeybindingsManager;
  const factory = createMenuPicker({ ui: { setEditorComponent } }, { items: () => items, onSelect, onCancel, autoSubmit: opts.autoSubmit });
  const editor = factory(tui as unknown as TUI, theme, kb);
  return { editor, tui, setEditorComponent, onSelect, onCancel };
}

test("Enter on the first item (no navigation) selects it", () => {
  const { editor, onSelect } = makeEditor();
  editor.handleInput("\r");
  assert.equal(onSelect.mock.calls.length, 1);
  assert.equal(onSelect.mock.calls[0][0].value, "/alpha");
});

test("↓ then Enter selects the second item", () => {
  const { editor, onSelect } = makeEditor();
  editor.handleInput("\u001b[B"); // down
  editor.handleInput("\r"); // confirm
  assert.equal(onSelect.mock.calls[0][0].value, "/beta");
});

test("↓ ↓ ↓ clamps at the last item", () => {
  const { editor, onSelect } = makeEditor();
  editor.handleInput("\u001b[B");
  editor.handleInput("\u001b[B");
  editor.handleInput("\u001b[B"); // past the end → clamp
  editor.handleInput("\r");
  assert.equal(onSelect.mock.calls[0][0].value, "/gamma");
});

test("↑ at the top clamps (stays on the first item)", () => {
  const { editor, onSelect } = makeEditor();
  editor.handleInput("\u001b[A"); // up while at top
  editor.handleInput("\r");
  assert.equal(onSelect.mock.calls[0][0].value, "/alpha");
});

test("Esc cancels (onCancel fires, onSelect does not)", () => {
  const { editor, onSelect, onCancel } = makeEditor();
  editor.handleInput("\u001b");
  assert.equal(onCancel.mock.calls.length, 1);
  assert.equal(onSelect.mock.calls.length, 0);
});

test("accept hides the overlay and restores the default editor", () => {
  const { editor, tui, setEditorComponent } = makeEditor();
  editor.handleInput("\r");
  assert.equal(tui.hideOverlay.mock.calls.length, 1, "overlay hidden");
  assert.equal(setEditorComponent.mock.calls.length, 1, "editor component reset");
  assert.equal(setEditorComponent.mock.calls[0][0], undefined, "restored to default editor");
});

test("empty-state: Enter with no items is a no-op (no select, no close)", () => {
  const onSelect = mock(() => {});
  const { editor, tui } = makeEditor({ items: [], onSelect });
  editor.handleInput("\r");
  assert.equal(onSelect.mock.calls.length, 0, "no selection on empty list");
  assert.equal(tui.hideOverlay.mock.calls.length, 0, "did not close");
});

test("after close, further nav/confirm is inert (closed guard)", () => {
  const { editor, onSelect } = makeEditor();
  editor.handleInput("\r"); // accept → closes
  editor.handleInput("\r"); // second Enter → closed, ignored
  assert.equal(onSelect.mock.calls.length, 1, "only the first accept fired");
});

test("autoSubmit: accept calls the framework-wired onSubmit with the item value", () => {
  // setCustomEditorComponent wires `newEditor.onSubmit = defaultEditor.onSubmit`
  // (the interactive-mode slash-dispatch fn). We simulate that wiring here.
  const submitMock = mock(() => {});
  const { editor, onSelect } = makeEditor({ autoSubmit: true });
  editor.onSubmit = submitMock;
  editor.handleInput("\r");
  assert.equal(onSelect.mock.calls.length, 1, "onSelect still fires (side-effects)");
  assert.equal(submitMock.mock.calls.length, 1, "onSubmit called (auto-run)");
  assert.equal(submitMock.mock.calls[0][0], "/alpha", "submits the item value");
});

test("without autoSubmit, accept does not call onSubmit (fill-prompt model)", () => {
  const submitMock = mock(() => {});
  const { editor } = makeEditor(); // autoSubmit unset
  editor.onSubmit = submitMock;
  editor.handleInput("\r");
  assert.equal(submitMock.mock.calls.length, 0, "no auto-run without autoSubmit");
});
