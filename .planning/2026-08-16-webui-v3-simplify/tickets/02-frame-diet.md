---
id: 02
title: "frame diet: wiring allowlist + store trim"
status: open
---

## Goal
D4: web clients receive ONLY: card, card_done, report, ask_user, ask_user_done,
appexec, session_info, view_opened, snapshot, error, mutex_blocked,
mutex_force_release. Everything else (message_*, tool_execution_*, tool_result,
turn_*, agent_settled, session_*compact) is TUI-only.

## Notes for implementer
- Single allowlist const in webui-wiring.ts applied at the store-wrapped
  broadcast seam (store append + live broadcast share it).
- session-store.ts: append() drops non-allowlisted BEFORE storing (store never
  holds log frames) → cap/eviction machinery likely removable — verify the
  only consumers are snapshot/replay, then delete FIFO splice + its tests.
- ask-card tombstones, card_done answers, report frames MUST survive replay.
- Tests: allowlist unit (each dropped type never stored/broadcast; each kept
  type flows), snapshot replay still renders cards/reports after diet.

## Done when
webui suite green; a replay snapshot contains zero log frames; docs updated.
