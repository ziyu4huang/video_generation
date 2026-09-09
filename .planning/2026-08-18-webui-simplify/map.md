---
effort: 2026-08-18-webui-simplify
created: 2026-08-18
last: 2026-09-09
status: paused
---

# webui-simplify — 2026-08-18

## Destination

Simplify webui per the user-approved spec (chat = minimal bar in Inbox; all three simplifications selected), executed as one effort with four sequenced PRs: PR1 chat restore (#1683), PR2 tab consolidation More (#1684), PR3 SSE→WS transport merge (#1685), PR4 JSONL store merge — plus the webui+tui mix-pattern catalog research.

Status: active. Spec approved by user (chat = minimal bar in Inbox; all three
simplifications selected). Execution structure A: one effort, four sequenced
PRs.

Origin: user doctrine audit — "webui must be a BONUS to the TUI, never
conflict; BTW must be ADDITIONAL; reuse code; no confused/unclear features;
it seems not usable to do AI chat" (the v3 de-chat rebuild #1505 removed the
browser composer; protocol/transport/seams all survived).

## Follow-ups
1. PR1 — chat restore (#1683 merged)
2. PR2 — tab consolidation More (#1684 merged)
3. PR3 — SSE->WS transport merge (#1685 merged)
4. PR4 — JSONL store merge (shared jsonl-mirror.ts helper) [next]
5. Research: webui+tui mix-pattern catalog -> .planning/knowledge/webui-tui-mix-patterns.md
   (live web/ZAI unavailable in harness; synthesized from pi local docs + model
   knowledge; gap candidates G1-G4 listed there, user-decision-gated)

## Shipped-so-far (assessed 2026-09-09 by 2026-09-09-planning-audit)

PR1 chat restore, PR2 tab consolidation More, PR3 SSE→WS transport merge. PRs: #1683, #1684, #1685.

Parked 2026-09-09 by stall: PR4 (JSONL store merge via shared jsonl-mirror.ts) was explicitly [next] and never landed. Reopen by shipping PR4; mix-pattern research already in .planning/knowledge/.
