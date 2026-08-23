# Status Bar Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Down-at-empty-editor trigger in `pi-agent-ext-core-task` that opens a selector panel of the active composite-status elements (goal / todo / wayfind); selecting one runs its slash command (flat-trigger). Nothing actionable → Down passes through. No core patch.

**Architecture:** Reuse the proven `pi-agent-ext-picker` interactive pattern (`onTerminalInput` raw-key capture → `ctx.ui.setEditorComponent(CustomEditor)` + nonCapturing `SelectList` overlay → `autoSubmit` runs the command via the framework-wired `onSubmit` slash-dispatch). Built only from `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` primitives — **no import from sibling `pi-agent-ext-*` packages** (the repo coordinates cross-extension via `globalThis` seams, never cross-package imports). Three new modules under `src/status-launcher/` wired from the existing `extensions/core-task.ts` `session_start` handler.

**Tech Stack:** TypeScript, Bun (runtime + `bun:test` + `mock`), `@earendil-works/pi-coding-agent` (`CustomEditor`, `KeybindingsManager`, `ExtensionUIContext`), `@earendil-works/pi-tui` (`SelectList`, `SelectItem`, `SelectListTheme`, `Key`, `matchesKey`, `Component`, `EditorTheme`, `OverlayAnchor`, `TUI`), Biome (lint/format), `tsc --noEmit` (typecheck).

## Global Constraints

- **Peer deps only:** `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` `0.83.0`, `typebox ^1.3.6` (already in `pi-agent-ext-core-task/package.json` `peerDependencies`). Do NOT add a dependency on `@repo/pi-agent-ext-picker` or any sibling ext package.
- **One canonical entry:** all wiring goes through `extensions/core-task.ts` (the package's single registered extension). New logic lives in `src/status-launcher/`.
- **Extension surface only — no core patch.** Path A (inline-focusable bar) is explicitly deferred.
- **Commands carry a leading slash** (matches `pi-agent-ext-picker`'s `toCommandItems`: `value: "/${name}"`), because `autoSubmit` calls `onSubmit(item.value)` and the slash-dispatch expects `/cmd`.
- **Presence seams (read-only):** `globalThis.__piGoalActive?.()` (callable, published by core-task itself), `globalThis.__piWayfindActive?.()` (callable, published by `pi-agent-ext-wayfind`). Todo presence is in-process (`getTodos()`).
- **Written artifacts in English.** Conventional Commits (`feat(...)`, `test(...)`, `docs(...)`).
- **Run tests from the package dir:** `( cd bun-apps/pi-agent-ext-core-task && bun test )`. Typecheck: `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck )`. (Never top-level `cd` — use a subshell or `--cwd`.)

## File Structure

| File | Responsibility |
|---|---|
| `src/status-launcher/presence.ts` | `PanelEntry` type + `getPanelEntries(deps?)` — which elements are actionable and their command strings (filtered, ordered). |
| `src/status-launcher/presence.test.ts` | Presence logic: goal/todo/wayfind present-conditions, order, filtering, graceful seam-absent. |
| `src/status-launcher/panel.ts` | `StatusPanelOverlay` (Component: fixed `SelectList`, selection state) + `StatusPanelEditor` (`CustomEditor`: overlay + key routing + accept/cancel) + `createStatusPanel()` factory. |
| `src/status-launcher/panel.test.ts` | Editor key routing (↓/↑/Enter/Esc), selection clamp, autoSubmit `onSubmit`, close + `onDone`. |
| `src/status-launcher/trigger.ts` | `registerStatusLauncherTrigger(ctx, deps?)` — `onTerminalInput` Down-at-empty handler with re-entry guard + pass-through conditions. |
| `src/status-launcher/trigger.test.ts` | Handler decision tree: non-Down / non-empty / no-entries → pass-through; Down + empty + entries → open + consume; re-entry guard; re-arm via `onDone`. |
| `extensions/core-task.ts` (modify) | Call `registerStatusLauncherTrigger(ctx)` inside the existing `session_start` `if (ctx.hasUI)` block. |

**Interfaces across tasks:**
- `PanelEntry = { id: "goal" | "todo" | "wayfind"; label: string; command: string }` (defined Task 1, consumed Task 2 & 3).
- `createStatusPanel(ctx, entries, { onDone }) → factory` (defined Task 2, consumed Task 3).
- `registerStatusLauncherTrigger(ctx, deps?) → removeFn` (defined Task 3, consumed Task 4).

---

### Task 1: `presence.ts` — element presence + command mapping

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/status-launcher/presence.ts`
- Test: `bun-apps/pi-agent-ext-core-task/src/status-launcher/presence.test.ts`

**Interfaces:**
- Produces: `export type StatusElementId = "goal" | "todo" | "wayfind"`; `export interface PanelEntry { id: StatusElementId; label: string; command: string }`; `export interface PresenceDeps { isGoalActive: () => boolean; getTodoCount: () => number; isWayfindActive: () => boolean }`; `export function getPanelEntries(deps?: PresenceDeps): PanelEntry[]`.
- Consumes (defaults): `isGoalActive` from `../goal/goal.js`; `getTodos` from `../todo/state/store.js`; the `globalThis.__piWayfindActive` seam.

- [ ] **Step 1: Write the failing test**

`src/status-launcher/presence.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { getPanelEntries, type PresenceDeps } from "./presence.js";

const deps = (overrides: Partial<PresenceDeps> = {}): PresenceDeps => ({
  isGoalActive: () => false,
  getTodoCount: () => 0,
  isWayfindActive: () => false,
  ...overrides,
});

test("all absent → empty list", () => {
  assert.deepEqual(getPanelEntries(deps()), []);
});

test("goal present → first entry, command '/goal'", () => {
  const e = getPanelEntries(deps({ isGoalActive: () => true }));
  assert.equal(e.length, 1);
  assert.equal(e[0].id, "goal");
  assert.equal(e[0].command, "/goal");
});

test("todo present → command '/todos'", () => {
  const e = getPanelEntries(deps({ getTodoCount: () => 3 }));
  assert.equal(e.length, 1);
  assert.equal(e[0].id, "todo");
  assert.equal(e[0].command, "/todos");
});

test("wayfind present → command '/wayfind status'", () => {
  const e = getPanelEntries(deps({ isWayfindActive: () => true }));
  assert.equal(e.length, 1);
  assert.equal(e[0].id, "wayfind");
  assert.equal(e[0].command, "/wayfind status");
});

test("order is goal, todo, wayfind when all present", () => {
  const e = getPanelEntries(deps({ isGoalActive: () => true, getTodoCount: () => 1, isWayfindActive: () => true }));
  assert.deepEqual(e.map((x) => x.id), ["goal", "todo", "wayfind"]);
});

test("todo count of 0 is absent (hidden)", () => {
  assert.equal(getPanelEntries(deps({ getTodoCount: () => 0 })).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/status-launcher/presence.test.ts )`
Expected: FAIL — `Cannot find module "./presence.js"` / `getPanelEntries is not a function`.

- [ ] **Step 3: Write minimal implementation**

`src/status-launcher/presence.ts`:

```ts
/**
 * presence.ts — which composite-status elements are actionable right now, and
 * the slash-command each one runs when selected from the launcher panel.
 *
 * Pure + dependency-injected (defaults read the real sources) so the decision
 * tree is fully unit-testable without touching goal/todo state or globalThis.
 * Commands carry a leading "/" (parity with pi-agent-ext-picker's toCommandItems)
 * because the panel auto-submits via the framework-wired onSubmit slash-dispatch.
 */
import { isGoalActive } from "../goal/goal.js";
import { getTodos } from "../todo/state/store.js";

export type StatusElementId = "goal" | "todo" | "wayfind";

export interface PanelEntry {
  id: StatusElementId;
  label: string;
  command: string;
}

export interface PresenceDeps {
  isGoalActive: () => boolean;
  getTodoCount: () => number;
  isWayfindActive: () => boolean;
}

/** Read the callable globalThis wayfind seam; absent/non-callable → false. */
function defaultWayfindActive(): boolean {
  const fn = (globalThis as Record<string, unknown>).__piWayfindActive;
  return typeof fn === "function" ? (fn as () => boolean)() : false;
}

const defaultDeps: PresenceDeps = {
  isGoalActive,
  getTodoCount: () => getTodos().length,
  isWayfindActive: defaultWayfindActive,
};

/**
 * Actionable elements in composite-widget section order (goal=0, todo=1,
 * wayfind=2). Absent elements are omitted (hide-empty). Empty list ⇒ the
 * trigger passes Down through (no panel).
 */
export function getPanelEntries(deps: PresenceDeps = defaultDeps): PanelEntry[] {
  const entries: PanelEntry[] = [];
  if (deps.isGoalActive()) entries.push({ id: "goal", label: "goal — show active goal", command: "/goal" });
  if (deps.getTodoCount() > 0) entries.push({ id: "todo", label: "todo — open list", command: "/todos" });
  if (deps.isWayfindActive()) entries.push({ id: "wayfind", label: "wayfind — status", command: "/wayfind status" });
  return entries;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/status-launcher/presence.test.ts )`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/status-launcher/presence.ts bun-apps/pi-agent-ext-core-task/src/status-launcher/presence.test.ts
git commit -m "feat(core-task): status-launcher presence — element→command mapping"
```

---

### Task 2: `panel.ts` — selector overlay + editor

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/status-launcher/panel.ts`
- Test: `bun-apps/pi-agent-ext-core-task/src/status-launcher/panel.test.ts`

**Interfaces:**
- Consumes: `PanelEntry` from `./presence.js` (Task 1).
- Produces: `export interface StatusPanelCtx { ui: { setEditorComponent(factory: unknown): void } }`; `export interface StatusPanelOptions { onDone: () => void }`; `export type StatusPanelFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => StatusPanelEditor`; `export function createStatusPanel(ctx: StatusPanelCtx, entries: PanelEntry[], opts: StatusPanelOptions): StatusPanelFactory`.
- Reference (do NOT import — mirror): `pi-agent-ext-picker/src/menu-picker.ts` + `menu-render.ts`.

- [ ] **Step 1: Write the failing test**

`src/status-launcher/panel.test.ts` (mirrors `pi-agent-ext-picker/tests/menu-picker.test.ts` byte sequences + mock tui/kb):

```ts
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
  const submit = mock(() => {});
  editor.onSubmit = submit;
  editor.handleInput("\r");
  assert.equal(submit.mock.calls.length, 1);
  assert.equal(submit.mock.calls[0][0], "/goal");
});

test("↓ then Enter selects '/todos'", () => {
  const { editor } = makePanel();
  const submit = mock(() => {});
  editor.onSubmit = submit;
  editor.handleInput("\u001b[B"); // down
  editor.handleInput("\r");
  assert.equal(submit.mock.calls[0][0], "/todos");
});

test("↓↓↓↓ clamps to the last item ('/wayfind status')", () => {
  const { editor } = makePanel();
  const submit = mock(() => {});
  editor.onSubmit = submit;
  editor.handleInput("\u001b[B"); editor.handleInput("\u001b[B"); editor.handleInput("\u001b[B"); // past end
  editor.handleInput("\r");
  assert.equal(submit.mock.calls[0][0], "/wayfind status");
});

test("↑ at top stays on first item", () => {
  const { editor } = makePanel();
  const submit = mock(() => {});
  editor.onSubmit = submit;
  editor.handleInput("\u001b[A"); // up while at top
  editor.handleInput("\r");
  assert.equal(submit.mock.calls[0][0], "/goal");
});

test("Esc cancels: hides overlay, restores editor, calls onDone, no submit", () => {
  const { editor, tui, setEditorComponent, onDone } = makePanel();
  const submit = mock(() => {});
  editor.onSubmit = submit;
  editor.handleInput("\u001b"); // esc
  assert.equal(tui.hideOverlay.mock.calls.length, 1);
  assert.equal(setEditorComponent.mock.calls[0][0], undefined);
  assert.equal(onDone.mock.calls.length, 1);
  assert.equal(submit.mock.calls.length, 0);
});

test("Enter closes then is ignored (re-entry after close)", () => {
  const { editor, tui } = makePanel();
  editor.onSubmit = mock(() => {});
  editor.handleInput("\r"); // accept → close
  assert.equal(tui.hideOverlay.mock.calls.length, 1);
  editor.handleInput("\r"); // second enter → closed, no-op
  assert.equal(tui.hideOverlay.mock.calls.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/status-launcher/panel.test.ts )`
Expected: FAIL — `Cannot find module "./panel.js"`.

- [ ] **Step 3: Write minimal implementation**

`src/status-launcher/panel.ts` (mirrors `menu-picker.ts`/`menu-render.ts`, fixed-list — no filter):

```ts
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
  invalidate(): void {
    this.invalidateFn();
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
    this.overlay.setInvalidate(() => this.tui.invalidate());
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/status-launcher/panel.test.ts )`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/status-launcher/panel.ts bun-apps/pi-agent-ext-core-task/src/status-launcher/panel.test.ts
git commit -m "feat(core-task): status-launcher selector panel (SelectList editor)"
```

---

### Task 3: `trigger.ts` — Down-at-empty handler

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/status-launcher/trigger.ts`
- Test: `bun-apps/pi-agent-ext-core-task/src/status-launcher/trigger.test.ts`

**Interfaces:**
- Consumes: `PanelEntry` + `getPanelEntries` from `./presence.js` (Task 1); `createStatusPanel` from `./panel.js` (Task 2).
- Produces: `export interface TriggerCtx { ui: ExtensionUIContext }`; `export interface TriggerDeps { isDownKey: (data: string) => boolean; getEntries: () => PanelEntry[]; openPanel: (ctx: TriggerCtx, entries: PanelEntry[], opts: { onDone: () => void }) => void }`; `export function registerStatusLauncherTrigger(ctx: TriggerCtx, deps?: TriggerDeps): () => void` (returns the `onTerminalInput` remove-fn).

- [ ] **Step 1: Write the failing test**

`src/status-launcher/trigger.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/status-launcher/trigger.test.ts )`
Expected: FAIL — `Cannot find module "./trigger.js"`.

- [ ] **Step 3: Write minimal implementation**

`src/status-launcher/trigger.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/status-launcher/trigger.test.ts )`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/status-launcher/trigger.ts bun-apps/pi-agent-ext-core-task/src/status-launcher/trigger.test.ts
git commit -m "feat(core-task): status-launcher Down-at-empty trigger"
```

---

### Task 4: Wire the launcher into `extensions/core-task.ts`

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-task/extensions/core-task.ts` (add import + one call inside the existing `session_start` `if (ctx.hasUI)` block)
- Test: `bun-apps/pi-agent-ext-core-task/src/status-launcher/wiring.test.ts` (new — asserts session_start registers the trigger)

**Interfaces:**
- Consumes: `registerStatusLauncherTrigger` from `../src/status-launcher/trigger.js` (Task 3).

- [ ] **Step 1: Write the failing test**

`src/status-launcher/wiring.test.ts` (invokes the extension factory with a permissive fake `pi`, captures the `session_start` handler, asserts it registers `onTerminalInput`):

```ts
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import extension from "../../extensions/core-task.js";

/**
 * Permissive fake pi via Proxy: `on(event, h)` is captured; ANY other property
 * access returns a no-op mock — absorbs the factory's many registerTool /
 * registerCommand / getConfig / ... calls (from goal(), registerLoop,
 * registerAskUser, …) without enumerating them.
 */
function fakePi(): { pi: unknown; handlers: Record<string, ((...a: unknown[]) => unknown)[]> } {
  const handlers: Record<string, ((...a: unknown[]) => unknown)[]> = {};
  const pi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "on")
          return (event: string, h: (...a: unknown[]) => unknown) => {
            (handlers[event] ??= []).push(h);
          };
        return mock((..._args: unknown[]) => {});
      },
    },
  );
  return { pi, handlers };
}

test("session_start with hasUI registers the launcher trigger (onTerminalInput)", async () => {
  const { pi, handlers } = fakePi();
  extension(pi as never);
  assert.ok(handlers.session_start?.length, "session_start handler registered");
  const onTerminalInput = mock((_h: unknown) => () => {});
  const ctx = {
    hasUI: true,
    ui: { onTerminalInput, setUICtx: mock(() => {}), setWidget: mock(() => {}), notify: mock(() => {}) },
    cwd: "/tmp",
    sessionManager: { getSessionId: () => "s1" },
  };
  await handlers.session_start[0]({} as never, ctx as never);
  assert.equal(onTerminalInput.mock.calls.length, 1, "trigger's onTerminalInput was called");
});

test("session_start without UI does NOT register the trigger", async () => {
  const { pi, handlers } = fakePi();
  extension(pi as never);
  const onTerminalInput = mock((_h: unknown) => () => {});
  await handlers.session_start[0]({} as never, { hasUI: false, cwd: "/tmp", ui: { onTerminalInput } } as never);
  assert.equal(onTerminalInput.mock.calls.length, 0);
});
```

> **Note to implementer:** if `restoreLoopFromSession` / `refreshPlan` (called earlier in the same `session_start` handler) throw on the minimal fake `ctx`, widen the fake `ctx` (e.g. give `sessionManager` whatever those read) rather than weakening the assertion. The assertion target — `onTerminalInput` called once when `hasUI` — is fixed.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/status-launcher/wiring.test.ts )`
Expected: FAIL — `onTerminalInput.mock.calls.length` is 0 (the call isn't wired yet).

- [ ] **Step 3: Make the edit**

In `extensions/core-task.ts`:

(a) Add the import with the other `status-launcher`-adjacent imports (after the `getSharedStatusWidget` import line):

```ts
import { registerStatusLauncherTrigger } from "../src/status-launcher/trigger.js";
```

(b) Inside the existing `pi.on("session_start", …)` handler, within the `if (ctx.hasUI) { … }` block (right after `statusWidget.update();`), add:

```ts
			registerStatusLauncherTrigger(ctx);
```

The resulting block reads:

```ts
		if (ctx.hasUI) {
			statusWidget.setUICtx(ctx.ui);
			todoOverlay.resetCompletedDisplayState();
			statusWidget.update();
			registerStatusLauncherTrigger(ctx);
		}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/status-launcher/wiring.test.ts )`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole package test suite + typecheck**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test && bun run typecheck )`
Expected: all tests PASS (existing + new status-launcher tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/extensions/core-task.ts bun-apps/pi-agent-ext-core-task/src/status-launcher/wiring.test.ts
git commit -m "feat(core-task): wire status-launcher trigger on session_start"
```

---

### Task 5: Manual acceptance (live TUI — not automatable)

The byte sequences + overlays are unit-tested above, but the live render + real keybinding bytes + the `setEditorComponent`/`onSubmit` slash-dispatch only prove out in the running TUI.

- [ ] **Start the agent in interactive mode** in a session where the composite widget is active (an active `/goal`, a non-empty todo, or an active wayfind effort).
- [ ] **With an empty prompt, press ↓** → the launcher panel opens, listing only the elements with state, in goal→todo→wayfind order.
- [ ] **↑/↓** moves the highlight; **Enter** on each element runs its command (`/goal`, `/todos`, `/wayfind status`) and closes the panel.
- [ ] **Esc** closes the panel and restores the normal editor.
- [ ] **With a non-empty prompt**, ↓ does its normal thing (cursor/history) — panel does NOT open.
- [ ] **In a session with no goal / no todo / no wayfind**, ↓ at an empty prompt behaves normally (panel does NOT open).
- [ ] **Fallback gate:** if ↓ does NOT open the panel (Down-key bytes not matched by `matchesKey(data, Key.down)` on this terminal), implement the `pi.registerShortcut(<dedicated-key>, { handler })` fallback documented in the spec §7 — bind a dedicated key that calls the same `openPanel` path unconditionally. (This is the only known residual.)

- [ ] **Record the outcome** in the PR description (which path shipped — primary `onTerminalInput` or the `registerShortcut` fallback).

---

## Self-Review (run after writing — issues found & fixed inline)

- **Spec coverage:** spec §2 destination → Tasks 1–4; §3 decisions (flat-trigger, hide-empty, in core-task, picker pattern) → all reflected; §5 components (presence/trigger/panel) → Tasks 1/3/2; §7 trigger residual (Down-key + registerShortcut fallback) → Task 3 default + Task 5 fallback gate; §8 error handling (RPC guard, empty pass-through, seam-absent, re-entry) → trigger.ts + presence.ts; §9 testing → every module has a test file. No spec section lacks a task.
- **Placeholder scan:** no TBD/TODO; every code step contains the actual code; the one implementer-discretion note (Task 4 widening the fake ctx if `restoreLoopFromSession` needs more) is bounded with a fixed assertion target.
- **Type consistency:** `PanelEntry` (Task 1) consumed identically in Task 2 (`createStatusPanel(ctx, entries, opts)`) and Task 3 (`getEntries(): PanelEntry[]`); `createStatusPanel` signature matches between Task 2 (defined) and Task 3 (`defaultDeps.openPanel`); `registerStatusLauncherTrigger(ctx, deps?)` matches between Task 3 (defined) and Task 4 (called). Command strings carry "/" consistently (presence.ts emits `/goal` etc.; panel.test.ts asserts the same).
