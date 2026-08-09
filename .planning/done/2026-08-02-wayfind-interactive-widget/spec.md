# Interactive Status-Bar Launcher (Robust Rebuild) — Spec

## Problem Statement

The pi-agent TUI shows a composite status bar below the editor (the `pi-core-task` widget, `placement: "belowEditor"`) with up to three live elements: an active **goal**, **todos**, and an active **wayfind** effort. Today these elements are **read-only text** — to act on any of them the user must remember and type the backing slash command (`/goal`, `/todos`, `/wayfind status`). There is no quick way to go from "I see my status" to "do something about it."

A previous attempt (PR #1019, merged 2026-08-02) built a "Down-at-empty-editor opens a selector panel" launcher on the `onTerminalInput` raw-key trigger plus a `bottom-center` `SelectList` overlay. It was **deliberately deleted on 2026-08-07** as too fragile: the `onTerminalInput` listener teardown was unreliable across session lifecycle, and the `bottom-center` overlay orphaned on screen with an `invalidate()` re-entry cascade. The feature's intent — quick, key-driven access to status actions — remains unmet, but the fragile mechanism is gone. This spec rebuilds the feature robustly.

## Solution

A **robust interactive status-bar launcher**, rebuilt to eliminate both failure modes that killed PR #1019:

1. **Trigger via `registerShortcut`** on a dedicated **modified key** (proposed `Alt+Down`). `registerShortcut` is SDK-lifecycle-managed, so there is **no manual listener teardown** and thus no teardown hazard. A *modified* key never collides with plain-Down (input-history navigation) or normal editor input.

2. **Panel rendered as an inline `CustomEditor`** swapped in via `ctx.ui.setEditorComponent`, handling its own `↑`/`↓`/`Enter`/`Esc` in `handleInput` — **with no `tui.showOverlay`**. Because there is no overlay, there is nothing to orphan and no `invalidate()` cascade. On accept, the selected element's slash command runs and the default editor is restored (`setEditorComponent(undefined)`); on Esc, the default editor is restored with no command run. (This is the `pi-agent-ext-workflow` `workflow-editor` pattern, proven robust in-tree.)

The panel lists only the **active** composite-status elements (`goal` / `todo` / `wayfind`), in composite-widget order, **hiding** absent ones; selecting one **immediately runs** its backing slash command (flat-trigger).

## User Stories

1. As a pi-agent user with an active goal, I want to press a single key and pick "goal" from a panel so that `/goal` runs without me typing it.
2. As a user with pending todos, I want to press a single key and pick "todo" so that `/todos` opens my todo list.
3. As a user running a wayfind effort, I want to press a single key and pick "wayfind" so that `/wayfind status` shows my frontier and ticket counts.
4. As a user with multiple active elements, I want the panel to list them in a stable order (goal → todo → wayfind) so I can pick by position without reading each line.
5. As a user with no goal/todo/wayfind active, I want the launcher to do nothing (no empty panel) so I am never surprised.
6. As a user who opens the launcher by mistake, I want Esc to return me to exactly where I was, with nothing run.
7. As a user mid-typing, I want the launcher key to never hijack my input — the modified-key trigger is independent of editor content and of input-history navigation.
8. As a user, I want the launcher to survive session lifecycle events (start, compact, tree, shutdown) without leaving a stranded panel or listener — because the trigger is SDK-managed and the panel has no overlay to strand.
9. As a user in RPC/CLI (non-interactive) mode, I want zero impact — the launcher is UI-only and never registers outside interactive mode.
10. As a user with wayfind not installed, I want the wayfind element to simply be absent (graceful `globalThis.__piWayfindActive?.()` seam) rather than error.
11. As a developer, I want the launcher fully unit-testable without a live TUI, so the build is verifiable in CI.
12. As a developer, I want a documented live-TUI acceptance check that actually gets executed (unlike #1019's never-met Task 5) so the shipped behavior is confirmed.
13. As a developer, I want the feature isolated to `pi-agent-ext-core-task` with no new package and no core patch, so it lands cleanly.
14. As a developer, I want to reuse proven in-tree patterns (`workflow-editor` inline `CustomEditor`, `ask-user` `matchesKey`/`consume` helpers) rather than the deleted picker overlay, so I do not reintroduce its failure modes.

## Implementation Decisions

- **Trigger mechanism: `pi.registerShortcut(<modified-key>, { handler })`.** SDK-managed lifecycle; no manual subscribe/unsubscribe. The handler calls the same `openPanel` path unconditionally (no editor-state read required). Concrete key proposed: **`Alt+Down`** — to be verified free of conflict against all existing `registerShortcut` registrations and core keybindings before freeze; alternatives `Ctrl+Down` / `Shift+Down` if `Alt+Down` clashes. (The prior-art §7 fallback left this as a literal `<key>` placeholder; this spec closes it.)
- **Panel primitive: inline `CustomEditor` via `ctx.ui.setEditorComponent(factory)`, no overlay.** `factory: (tui, theme, keybindings) => CustomEditor` (from `@earendil-works/pi-coding-agent`). The editor renders the element list inline (in the editor slot) and routes `↑`/`↓`/`Enter`/`Esc` through its own `handleInput(data)` using `KeybindingsManager.matches(data, "tui.select.up|down|confirm|cancel")` (or `matchesKey` from `@earendil-works/pi-tui`). **Critically: `tui.showOverlay` is never called** — this is the hard divergence from the deleted picker and the source of robustness. (If a live-TUI check shows the inline slot cannot render ≤3 rows readably, fall back to the `ask-user` `option-list-view` / `SelectList` overlay primitive — which is robust in production — never the deleted `bottom-center` non-capturing overlay.)
- **Accept path:** `setEditorComponent(undefined)` (restore default editor) → dispatch the selected element's slash command (`/goal`, `/todos`, `/wayfind status`). Dispatch reuses the framework's existing slash-command channel; if the `registerShortcut` handler `ctx` cannot directly dispatch a slash string, the panel's accept wires through the same `setEditorComponent`/`autoSubmit`/`onSubmit` channel that #1019 used.
- **Cancel path:** `setEditorComponent(undefined)` → restore default editor → no command run.
- **Re-entry guard:** a `closed` / `active` flag on the editor so accept/cancel are no-ops after close (prevents double-dispatch).
- **Panel content & order (inherit #1019):**
  - `goal` (order 0) — present when `isGoalActive()` (in-process, `src/goal/goal.ts`); command `/goal`.
  - `todo` (order 1) — present when `getTodos().length > 0` (in-process, `src/todo/state/store.ts`); command `/todos`.
  - `wayfind` (order 2) — present when `globalThis.__piWayfindActive?.() ?? false` (callable seam published by `pi-agent-ext-wayfind`); command `/wayfind status`.
  - `plan-coordinator` (order 3) — **excluded** from this build (trivial to add later).
  - **Hide-empty:** absent elements are omitted, never greyed; if all are absent the launcher is a clean no-op (the shortcut still fires but `openPanel` renders nothing / returns immediately).
- **Element action model:** flat-trigger — one `Enter` immediately runs the element's command. No detail-expand, no sub-action menu.
- **Commands carry a leading slash** (`/goal`, `/todos`, `/wayfind status`) per the slash-dispatch contract (the prior plan, not the stale spec table, is canonical here).
- **Location & wiring:** lives in `pi-agent-ext-core-task`; new logic under `src/status-launcher/` (e.g. `presence.ts`, `panel.ts`, `wiring.ts`). `registerShortcut` is called once at extension init, gated on UI mode (`ctx.hasUI`). Wired from the existing `extensions/core-task.ts` factory.
- **Cross-extension coordination:** via `globalThis` seams only — no imports from sibling `pi-agent-ext-*` packages (repo convention). Only `wayfind` needs a seam; goal/todo are in-process.
- **Extension surface only — no core patch.** The inline-focusable status bar (Path A) remains deferred (wayfind ticket #03).
- **Peer deps:** `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui`, `typebox`. No new deps.
- **One canonical entry:** `extensions/core-task.ts`.
- **Written artifacts in English; Conventional Commits** (`feat(core-task): …`).

## Testing Decisions

- **Approach:** TDD red→green per module, pure-unit (no live TUI), mirroring `pi-agent-ext-core-task`'s `bun test` + `__tests__/` convention. Then a separate, actually-executed live-TUI acceptance pass (replacing #1019's never-met Task 5).
- **`presence` tests:** goal/todo/wayfind present-conditions; ordering goal→todo→wayfind; hide-empty filtering; `__piWayfindActive` seam-absent (graceful → hidden); empty-when-all-absent.
- **`panel` tests:** drive the `CustomEditor.handleInput` with terminal byte sequences (`\u001b[B` down, `\u001b[A` up, `\r` enter, `\u001b` esc) against a mock `tui`/`theme`/`keybindings`; assert ↑/↓/Enter/Esc routing; accept submits `"/goal"` / `"/todos"` / `"/wayfind status"`; ↓↓↓ clamps to last; ↑ at top stays; Esc restores editor + no submit; re-entry-after-close no-op. **Mock asserts `tui.showOverlay` is NEVER called (the robustness invariant).**
- **`wiring` tests:** a permissive Proxy-based fake `pi` absorbs the factory's many register* calls; asserts `registerShortcut` is called once (UI mode) with the chosen key, and zero times in non-UI mode; asserts the handler opens the panel via `setEditorComponent`.
- **Teardown/lifecycle tests (NEW vs #1019):** assert the launcher leaves no residual state across a simulated `session_start` re-fire and a session replacement — opening then simulating lifecycle events does not stack handlers or strand an editor. This directly encodes the lesson from the deletion.
- **Manual/acceptance (live TUI):** a checklist that is actually executed and recorded in the PR — start interactive mode with an active element; press the modified key → panel opens listing only active elements in order; ↑/↓/Enter runs each command; Esc restores; with no active elements the key is a clean no-op; across a `/compact` or session restart no panel/listener is stranded. Record which key shipped and which panel primitive shipped.
- **Invocation:** `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )`. No top-level `cd`.
