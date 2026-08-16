---
effort: webui-tui-parity
created: 2026-08-16
last: 2026-08-16
status: active
---
# webui-tui-parity — spec (one screen)

Two components, both riding the existing webui frame protocol (store-wrapped
broadcaster ⇒ replay-eligible by construction).

## C1 — ask-user tombstone (`ask_user_done`)
core-task emits `rpiv:ask-user:answered {promptId}` on EVERY execute exit
(questionnaire resolves on ANY surface, or exits early — no-UI fallback,
abort). webui broadcasts replay-eligible `ask_user_done {promptId}`; the shell
removes the dialog on the live frame AND after replay — sequential replay:
ask_user renders → ask_user_done removes → net no ghost.

## C2 — session status line (`session_info`)
On session_start webui broadcasts `session_info {cwd, branch?}` — cwd =
process.cwd(), branch = best-effort git rev-parse, empty on failure. Shell
renders a status line `path (branch)` in the header; replay-eligible.

## Non-goals
Model/token parity, themes.
