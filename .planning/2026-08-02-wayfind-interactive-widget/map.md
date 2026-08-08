# Wayfind Map — Interactive Status-Bar Launcher (Robust Rebuild)

## Destination

A **robust interactive status-bar launcher** for the pi-agent TUI: a dedicated modified-key shortcut opens a selector panel of the active composite-status elements (goal / todo / wayfind); selecting one immediately runs its backing slash command. Rebuilt to eliminate both failure modes that killed PR #1019 — the `onTerminalInput` teardown hazard and the `bottom-center` overlay orphaning — by using a `registerShortcut` trigger and an overlay-free inline `CustomEditor` panel.

## Notes

- Domain: pi-agent TUI extensions; owning package `pi-agent-ext-core-task`.
- Skills every session should consult: `wayfinder`, `to-spec`, `writing-plans`, `executing-plans`/SDD, `finishing-a-development-branch`.
- Prior art: `.planning/specs/2026-08-02-status-bar-launcher-design.md` + `.planning/plans/2026-08-02-status-bar-launcher.md` (#1019's design — sound, but never confirmed in the live TUI). Deleted implementation recoverable via `git show 1b5b5c63:bun-apps/pi-agent-ext-core-task/src/status-launcher/<file>.ts`.
- Hard constraints: extension surface only (no core patch); `globalThis` seams for cross-extension coordination (no cross-package imports); English artifacts; Conventional Commits.
- Operating worktree: `video_generation__superpowers` (this session).

## Decisions so far

- [Robust rebuild after PR #1019 deletion](tickets/04-robust-rebuild-after-pr1019-deletion.md) — abandon the `onTerminalInput` + `bottom-center overlay` approach; rebuild with a `registerShortcut` trigger + overlay-free inline `CustomEditor` panel.
- [Panel content + element→action mapping](tickets/01-panel-content-and-element-actions.md) — goal/todo/wayfind, hide-empty, `plan-coordinator` excluded; select → run slash command (`/goal`, `/todos`, `/wayfind status`), flat-trigger.
- [Trigger mechanism](tickets/02-trigger-mechanism.md) — `registerShortcut(<modified-key>)` (proposed `Alt+Down`), SDK-managed → no teardown hazard; no editor-state read needed.

## Deferred

- [Path A inline-focusable bar](tickets/03-path-a-inline-focus-followup.md) — the literal "click the status bar / focus into it" UX; requires a core patch to `pi-coding-agent`; deferred until the panel MVP proves the interaction is worth the core work.

## Status

**CHARTED → route clear.** DECIDE resolved; handed to SYNTHESIZE. Spec written: `spec.md`. Next: PLAN (`writing-plans`) → EXECUTE (SDD) → SHIP (`finishing-a-development-branch`).
