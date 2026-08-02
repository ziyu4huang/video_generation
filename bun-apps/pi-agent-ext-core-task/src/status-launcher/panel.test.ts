/**
 * Drives StatusPanelEditor.handleInput with terminal byte sequences for
 * ↓/↑/Enter/Esc against a mock tui/theme/keybindings — tests routing +
 * accept/cancel/close + autoSubmit, not pi-tui rendering.
 */
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { createStatusPanel } from "./panel.js";
import type { PanelEntry } from "./presence.js";

const ENTRIES: PanelEntry[] = [
  { id: "goal", label: "goal — show", command: "/goal" },
  { id: "todo", label: "todo — list", command: "/todos" },
  { id: "wayfind", label: "wayfind — status", command: "/wayfind status" },
];

/** terminal byte → keybinding id (mirrors the real KeybindingsManager). */
const DATA_ID: Record<string, string> = {
  "\u001b[B": "tui.select.down",
  "\u001b[A": "tui.select.up",
  "\r": "tui.select.confirm",
  "\u001b": "tui.select.cancel",
};

interface Handle {
  editor: ReturnType<ReturnType<typeof createStatusPanel>>;
  tui: { showOverlay: ReturnType<typeof mock>; hideOverlay: ReturnType<typeof mock>; invalidate: ReturnType<typeof mock> };
  setEditorComponent: ReturnType<typeof mock>;
  onDone: ReturnType<typeof mock>;
}

function makePanel(entries: PanelEntry[] = ENTRIES): Handle {
  const onDone = mock(() => {});
  const setEditorComponent = mock((_f: unknown) => {});
  const tui = { showOverlay: mock(() => {}), hideOverlay: mock(() => {}), invalidate: mock(() => {}) };
  const theme = { selectList: {} } as unknown as EditorTheme;
  const kb = { matches: (data: string, id: string) => DATA_ID[data] === id } as unknown as KeybindingsManager;
  const factory = createStatusPanel({ ui: { setEditorComponent } }, entries, { onDone });
  const editor = factory(tui as unknown as TUI, theme, kb);
  return { editor, tui, setEditorComponent, onDone };
}

test("Enter on first item auto-submits '/goal' via onSubmit", () => {
  const { editor } = makePanel();
  const submit = mock((_text: string) => {});
  editor.onSubmit = submit;
  editor.handleInput("\r");
  assert.equal(submit.mock.calls.length, 1);
  assert.equal(submit.mock.calls[0][0], "/goal");
});

test("↓ then Enter selects '/todos'", () => {
  const { editor } = makePanel();
  const submit = mock((_text: string) => {});
  editor.onSubmit = submit;
  editor.handleInput("\u001b[B"); // down
  editor.handleInput("\r");
  assert.equal(submit.mock.calls[0][0], "/todos");
});

test("↓↓↓↓ clamps to the last item ('/wayfind status')", () => {
  const { editor } = makePanel();
  const submit = mock((_text: string) => {});
  editor.onSubmit = submit;
  editor.handleInput("\u001b[B"); editor.handleInput("\u001b[B"); editor.handleInput("\u001b[B"); // past end
  editor.handleInput("\r");
  assert.equal(submit.mock.calls[0][0], "/wayfind status");
});

test("↑ at top stays on first item", () => {
  const { editor } = makePanel();
  const submit = mock((_text: string) => {});
  editor.onSubmit = submit;
  editor.handleInput("\u001b[A"); // up while at top
  editor.handleInput("\r");
  assert.equal(submit.mock.calls[0][0], "/goal");
});

test("Esc cancels: hides overlay, restores editor, calls onDone, no submit", () => {
  const { editor, tui, setEditorComponent, onDone } = makePanel();
  const submit = mock((_text: string) => {});
  editor.onSubmit = submit;
  editor.handleInput("\u001b"); // esc
  assert.equal(tui.hideOverlay.mock.calls.length, 1);
  assert.equal(setEditorComponent.mock.calls[0][0], undefined);
  assert.equal(onDone.mock.calls.length, 1);
  assert.equal(submit.mock.calls.length, 0);
});

test("Enter closes then is ignored (re-entry after close)", () => {
  const { editor, tui } = makePanel();
  editor.onSubmit = mock((_text: string) => {});
  editor.handleInput("\r"); // accept → close
  assert.equal(tui.hideOverlay.mock.calls.length, 1);
  editor.handleInput("\r"); // second enter → closed, no-op
  assert.equal(tui.hideOverlay.mock.calls.length, 1);
});
