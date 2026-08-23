---
ticket: 02-archify-present-wiring
effort: webui-present-adoption
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocked-by: [01]
blocking: [04]
---
# 02 — archify emits webui:present; answers → user-turn injection
Implement spec §C2. Touch: archify lib/open-announce.ts (emit both webui:open +
webui:present), webui present-event-handler.ts (answer routing via
sendUserMessage for event-originated presentations), tests both packages.
Acceptance: render success → shell toolbar with Approve/Regenerate…; tweak text
→ injected user turn `[webui:present] "<title>": tweak: "<text>"`; archify tool
result unchanged; zero cross-package imports.

## Result
02: archify emits webui:present (approve + free-text tweak) alongside webui:open; event-originated answers route to sendUserMessage user turns; webui 469 pass / 0 fail, archify green except known vendored-bin-recovery env failure.
