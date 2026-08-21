---
effort: 2026-08-16-webui-tui-parity
created: 2026-08-16
last: 2026-08-16
status: active
---
# webui-tui-parity — ghost-dialog fix + TUI status in the shell

## Destination

Fix the ghost-dialog resolution gap (a resolved/failed questionnaire must tombstone the shell dialog so it never re-appears on refresh) and surface TUI session context in the browser shell: a `session_info` status line showing worktree path/branch so the user knows which session a tab is co-driving.

## Context
Live demo (port 8799) exposed: (1) when a questionnaire resolves on ANY
surface (or fails, e.g. headless TUI), no resolution event reaches the webui —
the shell dialog becomes a ghost that re-appears on every refresh (replay has
no tombstone). (2) The shell shows zero TUI context (worktree path/branch) —
the user cannot tell WHICH session/worktree a browser tab is co-driving.

## Tickets
| Ticket | Type | Status | Summary |
|---|---|---|---|
| `tickets/01-ask-user-done-frame.md` | task | closed | resolution event → ask_user_done frame → shell tombstone |
| `tickets/02-session-info-status.md` | task | closed | session_info frame (cwd + branch) rendered as shell status line |

## Frontier
Next: 01 then 02, then docs line in webui README + review + merge.
