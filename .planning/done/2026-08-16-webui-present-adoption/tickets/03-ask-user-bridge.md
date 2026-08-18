---
ticket: 03-ask-user-bridge
effort: webui-present-adoption
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocked-by: [01]
blocking: [04]
---
# 03 — ask-user questionnaire mirrored into shell
Mirror ask-user into shell (spec §C3); start with recon of the exact
prompt/response event names in core-task ask-user.

## Result
03: ask-user bridge — prompt mirrored as replay-eligible ask_user frame; browser answers ride the loose appexec channel and re-emit as rpiv:ask-user:answer (consumed via ask-user doneRef, first-answer-wins); zero cross-package imports; webui 471 pass + core-task 826 pass.
