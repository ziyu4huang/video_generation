# Status Bar Launcher — Design Spec

- **Date:** 2026-08-02
- **Status:** Approved (brainstorm → ready for plan)
- **Branch:** `feat/status-bar-launcher` (based on `origin/main` @ `aa8a64fd`)
- **Owner package:** `bun-apps/pi-agent-ext-core-task`
- **Lineage:** Graduated from the wayfinder map `2026-08-02-wayfind-interactive-widget` (Path C). The map's tickets [01] (panel content + element→function) and [02] (trigger mechanism) are resolved by this spec; ticket [03] (Path A inline-focus, core patch) remains deferred.

## 1. Problem

The composite status bar (`pi-core-task` widget, rendered `belowEditor`) passively shows the active **goal / todo / wayfind** state, but it is **not interactive** — the SDK's `setWidget` is render-only (`ExtensionWidgetOptions` declares only `placement`; no focus / onClick / key). There is no "click the status bar" affordance. Users must type the relevant slash command (`/goal`, `/todos`, `/wayfind status`) to act on what the bar is showing.

The TUI focus model is **editor ↔ modal (binary)**; there is no "focus the inline widget" path today (every interactive flow opens a dedicated component via `setFocus()`). Making the bar itself focusable would require a core patch (Path A — deferred).

## 2. Destination (what "done" looks like)

An **interactive status-bar launcher**, delivered as **Path C** (panel MVP, no core patch):

- Pressing **Down at an empty editor** (the prompt is empty) opens a **selector panel** of the composite status elements that currently have real state (**goal / todo / wayfind**).
- **Selecting an element runs its command** (flat-trigger — one pick, one action).
- If **no element is actionable**, Down behaves normally (no panel opens).
- Built entirely on the **extension surface** — `onTerminalInput` raw-key capture + `setEditorComponent` — **no core patch**.

## 3. Resolved decisions (from brainstorming)

| Fork | Decision |
|---|---|
| Interaction model | **Flat-trigger** — select an element → immediately runs its primary command. (Not detail-expand, not sub-action menu.) |
| Empty / absent elements | **Hide them; if all empty, don't open the panel** (Down passes through). No dead/greyed entries. |
| Where it lives | **Inside `pi-agent-ext-core-task`** (owns the composite widget + goal/todo). goal+todo presence is in-process; only wayfind needs the existing `globalThis` seam. No new package. |
| Panel mechanism | **Reuse the `pi-agent-ext-picker` pattern** — `setEditorComponent` + SelectList + `autoSubmit` (select → submit command string via the interactive-mode slash-dispatch). |

## 4. Architecture

New code under `bun-apps/pi-agent-ext-core-task/src/status-launcher/`, wired from the package's **single canonical entry** `extensions/core-task.ts` (no new entry file — the convention is one registered extension per folder at `extensions/<X>.ts`).

```
src/status-launcher/
  presence.ts     # which elements are actionable + their command strings
  trigger.ts      # onTerminalInput: Down-at-empty → open panel (or pass-through)
  panel.ts        # the setEditorComponent payload (SelectList, Enter=run, Esc=cancel)
  __tests__/
    presence.test.ts
    trigger.test.ts
    panel.test.ts
```

`extensions/core-task.ts` gains, inside its existing `pi.on("session_start", …)` handler (guarded by `ctx.hasUI`):
- registration of the launcher's `onTerminalInput` trigger.

## 5. Components

### 5.1 `presence.ts` — what the panel lists

```ts
export interface PanelEntry {
  id: "goal" | "todo" | "wayfind";
  label: string;     // e.g. "wayfind — status"
  command: string;   // the string submitted to the slash-dispatch, e.g. "wayfind status"
}

// Returns ONLY present elements, in composite-widget section order (goal, todo, wayfind).
export function getPanelEntries(): PanelEntry[];
```

Presence + command mapping (the flat-trigger actions, all verified against current `origin/main`):

| Element | Present when | Command | Runs |
|---|---|---|---|
| `goal` | `isGoalActive()` — local to core-task (`src/goal/goal.ts`) | `"goal"` | `/goal` (no-arg → `showGoal`, displays the active goal) |
| `todo` | todo list is non-empty — local todo state (`src/todo/state/`) | `"todos"` | `/todos` (opens the todo list) |
| `wayfind` | `globalThis.__piWayfindActive?.() ?? false` | `"wayfind status"` | `/wayfind status` (frontier + ticket counts) |

- **Order** matches the composite widget's section order (goal=0, todo=1, wayfind=2) for spatial consistency with the bar.
- **`plan-coordinator` (section order=3) is excluded** from the MVP per the destination's three-element scope; trivial to add later.
- The exact todo-non-empty selector is confirmed at plan time (the todo state module exposes state via `src/todo/state/`; `todoOverlay.inspect()` already snapshots it).

### 5.2 `trigger.ts` — Down-at-empty → open panel

Registered on `session_start` (UI mode only):

```ts
ctx.ui.onTerminalInput((data) => {
  if (!isDownKey(data)) return undefined;                 // not Down → normal handling
  if (panelActive) return undefined;                      // re-entry guard
  if (ctx.ui.getEditorText() !== "") return undefined;    // editor not empty → Down = cursor/history nav
  const entries = getPanelEntries();
  if (entries.length === 0) return undefined;             // nothing actionable → Down passes through
  panelActive = true;
  ctx.ui.setEditorComponent(createPanel(ctx, entries, {
    onDone: () => { panelActive = false; },               // re-arm after run or cancel
  }));
  return { consume: true };                               // eat the Down
});
```

**Why `getEditorText() === ""` is the right condition:** when the prompt is empty the user is not mid-history-browse (browsing input history always shows text in the prompt), so Down's history-forward behavior is a no-op anyway — safe to repurpose. (Known edge: Up→Down back to empty leaves the next Down to open the panel; Esc closes it. Documented, acceptable.)

### 5.3 `panel.ts` — the selector component

`createPanel(ctx, entries, { onDone })` mirrors `pi-agent-ext-picker`'s `createMenuPicker`:
- Renders a vertical **SelectList** of `entries` (labels), ↑/↓ to navigate.
- **Enter** → `onSubmit(entries[selected].command)` with `autoSubmit: true` parity: the command string is dispatched as if typed (the interactive-mode slash-dispatch wired by `setEditorComponent`). One-Enter — no second confirmation (matches the flat-trigger decision).
- **Esc** → `onCancel` → restore the normal editor.
- Both paths call `onDone` to re-arm the trigger.

## 6. Data flow

```
session_start (ctx.hasUI)
  └─ core-task.ts registers onTerminalInput(trigger)
Down pressed
  └─ trigger: isDownKey? & getEditorText()===""? & entries non-empty?
       no  → return undefined (normal Down)
       yes → setEditorComponent(panel(entries)) + {consume:true}
panel open
  ├─ ↑/↓ navigate
  ├─ Enter → onSubmit("goal" | "todos" | "wayfind status") → command runs
  └─ Esc   → onCancel → restore editor
  (either → onDone → re-arm trigger)
```

## 7. Trigger residuals & fallback (honest)

- **Down-key representation in `onTerminalInput`'s `data`:** the picker matches printable chars (`data === "/"`); `ask-user` matches keybindings via a `matchesKey(data, key)` helper against keybind names like `tui.select.down`. The exact raw form an arrow key takes in `data` is **confirmed against the SDK at implementation** (a tiny unit test on the matcher). This is the one open prototype step; it does not change the design.
- **Fallback:** if Down-key matching proves brittle, **`pi.registerShortcut(<key>, { handler })`** binds a dedicated key (unconditional, no editor-state read needed) to open the panel — clean escape hatch, at the cost of the "Down-at-empty" UX. Either path is **no core patch**.
- These residuals correspond to wayfind-map ticket [02]'s tail; the mechanism itself (`onTerminalInput` + `getEditorText` + `setEditorComponent`) is **proven by `pi-agent-ext-picker`** in production.

## 8. Error handling

- **RPC / CLI mode** (`!ctx.hasUI`, or `ctx.ui` lacks `onTerminalInput`/`setEditorComponent`): the trigger is never registered; zero impact on non-interactive modes.
- **No actionable elements:** panel never opens; Down is pass-through. No dead UI.
- **Wayfind not loaded / seam absent:** `globalThis.__piWayfindActive?.() ?? false` → `false` → wayfind hidden. Graceful.
- **Command failure** (e.g. `/wayfind status` parse error): the command's own handler reports via `notify` (existing behavior); the panel has already handed off. No special handling.
- **Re-entry:** a `panelActive` guard prevents opening a panel over a panel.

## 9. Testing strategy

Pure-unit (no TUI) wherever possible, mirroring the repo's per-ext `bun test` + `__tests__/` convention.

- **`presence.test.ts`**
  - goal present iff `isGoalActive()`; todo iff non-empty; wayfind iff seam truthy.
  - absent elements are filtered out; order is goal→todo→wayfind.
  - empty list when all absent.
  - wayfind seam absent (`__piWayfindActive` undefined) → wayfind hidden (graceful).
- **`trigger.test.ts`** (fake `ctx.ui` capturing `onTerminalInput`/`getEditorText`/`setEditorText`/`setEditorComponent` calls + the returned `{consume}`):
  - non-Down key → `undefined` (pass-through).
  - Down + non-empty editor → `undefined`.
  - Down + empty + no entries → `undefined`.
  - Down + empty + entries → `setEditorComponent` called + returns `{consume:true}`.
  - re-entry guard (second Down while panel active → `undefined`).
  - `isDownKey` matcher unit-tested.
- **`panel.test.ts`** (drive the component):
  - renders entry labels in order.
  - Enter on selected → `onSubmit` called with that entry's command string.
  - Esc → `onCancel`; both paths call `onDone` (re-arm).
- **Manual / acceptance note** (checked at implementation, not automated): in the live TUI, Down-at-empty opens the panel; selecting each element runs its command; in an empty session Down behaves normally.

## 10. Scope

**In scope (MVP):**
- Three elements (goal / todo / wayfind), flat-trigger, hide-empty.
- Down-at-empty trigger via `onTerminalInput` (picker pattern), `registerShortcut` fallback.
- `setEditorComponent` SelectList panel, one-Enter run, Esc cancel.
- Lives in `pi-agent-ext-core-task`; presence via local state + `__piWayfindActive` seam.

**Out of scope (deferred):**
- **Path A — inline-focusable status bar (core patch):** Down moves focus *into* the bar (hover + Enter). Tracked as wayfind-map ticket [03]; separate core effort.
- **plan-coordinator as a 4th element** (easy add; section order=3 already exists).
- Detail-expand / sub-action-menu interaction models (flat-trigger chosen).
- Greyed-out "start one" affordance for empty elements (hide-empty chosen).

## 11. Open questions / risks

- **Down-key raw form** (§7) — low risk; matcher is unit-testable, `registerShortcut` is the fallback.
- **Todo-presence accessor** — the exact selector over `src/todo/state/` is nailed down at plan time (state is in-process; no new seam needed since the launcher lives in core-task).
- **Composite-widget parity** — the panel sources the same three sections the bar renders; if a future section is added to the bar, the launcher's `presence.ts` is the one place to extend (single source).

## 12. References

- **Reference implementation:** `bun-apps/pi-agent-ext-picker/extensions/picker.ts` + `src/menu-picker.ts` — the proven `onTerminalInput` + `getEditorComponent`/`setEditorComponent` + `autoSubmit` slash-dispatch pattern this design reuses.
- **Composite widget:** `bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts` (`getSharedStatusWidget`, sections, `belowEditor` placement).
- **Entry wiring:** `bun-apps/pi-agent-ext-core-task/extensions/core-task.ts` (`session_start`, `__piGoalActive` seam).
- **Coordination seams:** `__piGoalActive` (core-task), `__piWayfindActive` (wayfind `coordination.ts` / `state.ts` `isAnyWayfindSessionActive`).
- **`onTerminalInput` consume pattern:** `bun-apps/pi-agent-ext-core-task/src/ask-user/ask-user-question.ts` (`return { consume: true }`).
- **Wayfinder map:** `.planning/2026-08-02-wayfind-interactive-widget/map.md` (Path C destination + tickets 01–03).
