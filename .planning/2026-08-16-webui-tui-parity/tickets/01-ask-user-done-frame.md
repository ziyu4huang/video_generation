---
ticket: 01-ask-user-done-frame
effort: webui-tui-parity
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocked-by: none
blocking: []
---
# 01 — resolution event → ask_user_done frame → shell tombstone
core-task emits `rpiv:ask-user:answered {promptId}` on every execute exit
(any surface resolves, or early exit); webui broadcasts replay-eligible
`ask_user_done {promptId}` (spec C1).
Shell removes the dialog on the live frame AND after replay — sequential
replay (ask_user → ask_user_done) leaves no ghost on refresh.

## Result
Implemented + green: core-task emits `rpiv:ask-user:answered` in the ask_user
execute `finally` (all exits); webui broadcasts replay-eligible `ask_user_done`;
shell tombstones the dialog on promptId match. Gates: core-task 827, webui 472
tests, both typechecks clean.
