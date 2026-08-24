# Ticket 03 — alt+b opens the background-agents panel (CC Ctrl+B parity)

Status: pending

## Why

CC's Ctrl+B opens the background-agents panel — a view of background runs.
s2-agent's ctrl+b is a DETACH ACTION confined to the dock//subagents viewer,
the global detach is alt+s, and there is NO global key that OPENS the
background surface. Direction settled at the confirm-gate (map D4): map the
panel-opener to **alt+b** — ctrl+b stays pi's `tui.editor.cursorLeft`
(reclaiming it re-creates the ADR-subagent-0004 collision + startup
warning), alt+s detach unchanged.

## Scope

1. **Global alt+b** via `pi.registerShortcut` (extensions/subagent.ts):
   opens the existing background surface — the subagents dock focus when
   background runs exist (dock-claim.ts seam), falling back to the
   `/subagents` viewer when none do (or a dim "no background runs" notice,
   whichever the dock-claim seam makes natural). Reuse the surfaces; do NOT
   build a new widget.
2. **Deliverability**: alt+<letter> has the legacy ESC-prefix fallback
   (ctrl-b.ts:44-51 rationale) — pin `ESC+b` → "alt+b" via the same
   matchesKey test shape as detach-key-deliverable.test.ts; assert no
   conflict with pi built-ins (extension-shortcut-guard.test.ts pattern).
3. **DOCK_HINT_LINE + docs**: the hint line and README key table gain the
   alt+b row; ADR-subagent-0004 gets an amendment paragraph recording D4
   (alt+b panel-open ≠ ctrl+b detach; why ctrl+b was not reclaimed).
4. **Tests**: dispatcher (registry state → open target selection),
   deliverability pin, shortcut-guard addition.

Not in scope: changing alt+s, changing in-viewer ctrl+b detach, /agents
definitions management (map fog — uncharted).

## Done-when

- [ ] alt+b opens the background surface (manual TUI smoke receipt: with
      background runs → dock; without → viewer/notice).
- [ ] Legacy-terminal ESC+b fallback pinned by test; no pi shortcut
      conflicts (guard test green).
- [ ] ADR-subagent-0004 amended; DOCK_HINT_LINE + README updated.
- [ ] Canonical gates green; PR merged CLEAN via the devops chain; map
      ticket flipped.
