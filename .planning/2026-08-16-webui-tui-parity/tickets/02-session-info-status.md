---
ticket: 02-session-info-status
effort: webui-tui-parity
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocked-by: none
blocking: []
---
# 02 — session_info frame (cwd + branch) rendered as shell status line
On session_start webui broadcasts `session_info {cwd, branch?}` — cwd =
process.cwd(), branch = best-effort git rev-parse, empty on failure (spec C2).
Shell renders a status line `path (branch)` in the header; replay-eligible
so a refreshed tab still shows which session/worktree it co-drives.

## Result

02: session_info frame (cwd + best-effort branch) broadcast on session_start, replay-eligible; shell header status line; gate 473/0.
