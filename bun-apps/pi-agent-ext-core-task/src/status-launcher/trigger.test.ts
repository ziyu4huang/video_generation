import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { registerStatusLauncherTrigger, type TriggerCtx, type TriggerDeps } from "./trigger.js";
import type { PanelEntry } from "./presence.js";

const ENTRY: PanelEntry = { id: "goal", label: "goal", command: "/goal" };

interface FakeUi {
  onTerminalInput: ReturnType<typeof mock>;
  getEditorText: ReturnType<typeof mock>;
  setEditorComponent: ReturnType<typeof mock>;
}

function rig(entries: PanelEntry[], editorText = ""): { handler: (data: string) => unknown; ui: FakeUi; openPanel: ReturnType<typeof mock> } {
  const onTerminalInput = mock((h: (data: string) => unknown) => () => {}); // returns a remove fn
  const getEditorText = mock(() => editorText);
  const setEditorComponent = mock((_f: unknown) => {});
  const ui = { onTerminalInput, getEditorText, setEditorComponent } as unknown as FakeUi;
  const ctx = { ui } as unknown as TriggerCtx;
  const openPanel = mock(() => {});
  const deps: TriggerDeps = {
    isDownKey: (d) => d === "DOWN",
    getEntries: () => entries,
    openPanel,
  };
  registerStatusLauncherTrigger(ctx, deps);
  const handler = onTerminalInput.mock.calls[0][0] as (data: string) => unknown;
  return { handler, ui, openPanel };
}

test("non-Down key → pass-through (undefined)", () => {
  const { handler, openPanel } = rig([ENTRY]);
  assert.equal(handler("UP"), undefined);
  assert.equal(openPanel.mock.calls.length, 0);
});

test("Down + empty editor + entries → open + consume", () => {
  const { handler, openPanel } = rig([ENTRY]);
  assert.deepEqual(handler("DOWN"), { consume: true });
  assert.equal(openPanel.mock.calls.length, 1);
});

test("Down + non-empty editor → pass-through (normal Down nav)", () => {
  const { handler, openPanel } = rig([ENTRY], "some text");
  assert.equal(handler("DOWN"), undefined);
  assert.equal(openPanel.mock.calls.length, 0);
});

test("Down + empty + no entries → pass-through (nothing actionable)", () => {
  const { handler, openPanel } = rig([], "");
  assert.equal(handler("DOWN"), undefined);
  assert.equal(openPanel.mock.calls.length, 0);
});

test("re-entry guard: second Down while panel open → pass-through", () => {
  const { handler, openPanel } = rig([ENTRY]);
  assert.deepEqual(handler("DOWN"), { consume: true }); // opens
  assert.equal(handler("DOWN"), undefined); // guarded
  assert.equal(openPanel.mock.calls.length, 1);
});

test("onDone re-arms: after close, Down opens again", () => {
  const { handler, openPanel } = rig([ENTRY]);
  handler("DOWN"); // open
  // simulate the panel closing (accept/cancel calls onDone)
  const onDone = openPanel.mock.calls[0][2].onDone as () => void;
  onDone();
  assert.deepEqual(handler("DOWN"), { consume: true }); // re-armed
  assert.equal(openPanel.mock.calls.length, 2);
});
