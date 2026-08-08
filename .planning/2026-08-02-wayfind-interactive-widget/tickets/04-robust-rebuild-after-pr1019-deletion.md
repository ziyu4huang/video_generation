# 04 — Robust rebuild after PR #1019 deletion

**Type:** decision (closed)
**Date:** 2026-08-07

## Question

PR #1019 built this exact feature (Down-at-empty selector panel via `onTerminalInput` + a `bottom-center` `SelectList` overlay) and shipped it on 2026-08-02 — then it was **deliberately deleted on 2026-08-07** (`38fe1372`, `50906350`) as too fragile:
- the `onTerminalInput` listener teardown was unreliable across session lifecycle (start re-fires / session replacement);
- the `bottom-center` overlay orphaned on screen, with an `invalidate()` re-entry cascade (→ `RangeError`).

The charted destination is effectively a re-build of something already killed. How do we proceed?

## Decision

**Rebuild robustly on a different surface.** Abandon the `onTerminalInput` trigger and the `bottom-center` overlay entirely. Rebuild with:
- **Trigger:** `pi.registerShortcut(<modified-key>)` (proposed `Alt+Down`) — SDK-lifecycle-managed, so no manual teardown and no teardown hazard; a modified key never collides with plain-Down history navigation.
- **Panel:** an inline `CustomEditor` swapped via `ctx.ui.setEditorComponent` with **no `tui.showOverlay`** (the `pi-agent-ext-workflow` `workflow-editor` pattern) — no overlay means nothing to orphan and no `invalidate()` cascade.

## Rationale

The surviving design docs (#1019's spec + plan) are sound; the failure was in the *implementation's mechanism*, not the design intent. `registerShortcut` removes the listener-lifecycle class of bug; an overlay-free inline editor removes the orphan/cascade class of bug. Together they eliminate both documented failure modes while preserving the feature's intent — quick, key-driven access to status actions.

## Rejected alternatives

- **Resurrect #1019 + harden** — inherits the known-fragile mechanism; risks repeating the failure; the design itself anticipated fragility (its §7 fallback).
- **Don't rebuild (close as superseded)** — leaves the feature intent unmet; rejected because the intent is still wanted and a robust path exists.
- **Re-scope the destination** — the panel-via-shortcut model already satisfies "interactive status bar"; no redefinition needed.

## Carries forward (execution details)

- Pin the concrete modified key — verify it is free of conflict against all existing `registerShortcut` registrations and core keybindings before freeze.
- Confirm the inline panel can render ≤3 elements readably in the editor slot; if not, fall back to the robust `ask-user` overlay primitive (`option-list-view` / `SelectList`) — **never** the deleted `bottom-center` non-capturing overlay.

## Blocked by

None.
