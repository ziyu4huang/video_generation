# webui-simplify — 2026-08-18

Status: active. Spec approved by user (chat = minimal bar in Inbox; all three
simplifications selected). Execution structure A: one effort, four sequenced
PRs.

Origin: user doctrine audit — "webui must be a BONUS to the TUI, never
conflict; BTW must be ADDITIONAL; reuse code; no confused/unclear features;
it seems not usable to do AI chat" (the v3 de-chat rebuild #1505 removed the
browser composer; protocol/transport/seams all survived).

## Follow-ups
1. PR1 — chat restore (minimal composer in Inbox, revive agentic dispatch) [next]
2. PR2 — tab consolidation: Inbox/Cards/Report/More (BTW+Data fold into More; #data/#btw alias to #more)
3. PR3 — SSE->WS transport merge (cut /api/events + EventSource reader loop)
4. PR4 — JSONL store merge (shared jsonl-mirror.ts helper)
