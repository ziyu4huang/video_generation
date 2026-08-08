# 02 — Trigger mechanism (Down-at-empty → open panel)

## Question

How exactly does pressing **Down at an empty editor (no forward history)** open the selector panel, **without a core patch**, and without breaking the editor's existing Down/history navigation?

## Research findings (this charting session — trust, then verify in implementation)

- **`onTerminalInput(handler)` is confirmed** on the extension UI context (`pi-coding-agent/dist/core/extensions/types.d.ts:78`); `modes/interactive/interactive-mode.js` wires `addExtensionTerminalInputListener`. A handler receives raw key data and can **`consume`** it (preempt the editor). → Capturing Down is feasible at the extension layer.
- **`pi.registerShortcut(KeyId, { handler })`** is an alternative: bind a **dedicated** key (not Down) to open the panel. Avoids the editor-state problem entirely, but is not the user's "Down-at-empty" UX.

## Open crux (to resolve when this ticket is worked)

- **Detecting "editor empty + no forward history" from the handler.** The handler gets raw key bytes; it must decide whether the editor is in the state where Down should transfer to the panel (vs. its normal cursor-move / history-forward behavior). Open: is editor state (text content, history index) readable from the extension? If not, options:
  - The extension tracks editor emptiness itself (e.g. via keystroke heuristics or a state hook).
  - Fall back to a **dedicated shortcut** (`registerShortcut`) — clean, unconditional, but not "Down-at-empty".
- **Coexistence with history nav:** Down currently moves forward through input history when browsing. The capture must fire ONLY at empty-editor / no-forward-history, else it hijacks normal Down. Pin the exact condition + edge cases.

## Recommendation (tentative — confirm in implementation)

Prototype `onTerminalInput` Down-capture first; if reading editor state proves unavailable/brittle, fall back to `registerShortcut` with a dedicated key (and note the UX deviation). Either way: **no core patch for the MVP** (that's Path A, ticket [03](03-path-a-inline-focus-followup.md)).

type: research
blocked by: (none)

---

## Resolution (2026-08-07)

**Decided:** `pi.registerShortcut(<modified-key>)` (proposed `Alt+Down`), SDK-lifecycle-managed — **replaces** the fragile `onTerminalInput` approach that PR #1019 used and that was deleted on 2026-08-07.

**Research findings (ticket #02 tail):**
- `ctx.ui.onTerminalInput` *can* read `ctx.ui.getEditorText()` and thus detect an empty editor; and `pi.registerShortcut(Key.down, …)` is technically possible.
- BUT `registerShortcut` handlers cannot decline/fall-through (no return value), so registering plain `Key.down` would hijack input-history navigation. A **modified** key (`Alt+Down` / `Ctrl+Down` / `Shift+Down`) is required to avoid the collision.
- With a dedicated modified key, **no editor-state read is needed** at all — the trigger is unconditional.

Closed — recorded in `spec.md`; the robustness rationale (why not resurrect #1019) is captured in ticket #04.
