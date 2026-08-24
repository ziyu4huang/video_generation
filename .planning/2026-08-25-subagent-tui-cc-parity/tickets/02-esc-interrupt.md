# Ticket 02 — Esc interrupts a running foreground subagent

Status: pending

## Why

CC lets the user hit Esc while a subagent runs to interrupt it (the run
aborts, the parent turn continues with the abort result). s2-agent has no
display-surface interrupt for a FOREGROUND run (map Context): abort exists
only via the dock's `x` (background rows) or the caller's controller. A
long-running foreground child can only be waited out.

## Scope

1. **Investigate the input seam FIRST** (map fog): who owns Esc while a
   foreground tool call streams — pi's editor? the TUI's interrupt layer?
   Read pi's input routing (`ui.onTerminalInput`, the editor's keymap, any
   turn-interrupt Esc handling) and the existing byte-sniff precedent
   (`\x02` in subagent-viewer.ts, `\x0f` history in the retired context
   widget) before designing.
2. **Gate on an active foreground subagent run**: Esc is claimed ONLY while
   `registry.views({ foreground: true })` has a non-terminal run; with no
   live run, Esc passes through untouched (never steal Esc from the editor
   or pi's own interrupt).
3. **Abort semantics**: route to the same abort lever the dock's `x` uses
   (`convertToBackground` is NOT it — this is abort, status → aborted) so
   the run record, notify line, and settle rendering all behave exactly
   like an in-flight abort today. The parent sees the existing
   `Subagent aborted.` result shape (formatSubagentResult).
4. **Hint surface**: while a foreground subagent runs, surface a dim
   `esc to interrupt` hint on the live line (CC parity) — one segment in
   renderSubagentCall's streaming shape, no new widget.
5. **Tests**: dispatcher logic table-driven (live run + Esc → abort called
   once; no live run → passthrough; terminal entries not claimed),
   mirroring ctrl-b.ts's dispatchCtrlB test shape.

Not in scope: background-row abort (dock `x` already does it), Ctrl+B/alt+b
(t03), detach.

## Done-when

- [ ] Esc aborts an active foreground subagent run (manual TUI smoke
      receipt) and the run settles as `aborted` with the standard result.
- [ ] Esc passthrough verified when no foreground subagent runs (editor
      behavior unchanged; shortcut-guard test still green).
- [ ] Canonical gates green for every touched package.
- [ ] PR merged CLEAN via the devops chain; map ticket flipped.
