---
status: closed
---

# 03 — Disposition: 2026-08-01-continue-pipeline tickets 05 & 06 — live (migrate) or superseded (close)?

## type

`grilling` (HITL)

## Question

**Research finding (ticket 01, 2026-08-12):** both tickets ARE delivered in code — file2md emits on `pi:knowledge` (`file2md.ts:92,237,272`), knowledge-card has a sink subscriber calling `ingestRecords` (`knowledge-card.ts:1495`), converge loop wired (`converge.ts:61`). So the answer leans strongly to **close as superseded**; the remaining HITL question is only whether that delivered wiring is still wanted or is now dead code.

The `2026-08-01-continue-improve-the-pipeline-between-extension-` map's footer says tickets 05 (knowledge-card `pi:knowledge` sink subscriber) & 06 (file2md opt-in knowledge flag + direct emit) were "superseded by the 2026-08-08 implementation plan … close as superseded" — but they are **physically still open** (no status, `claimed: —`), and the canonical spine implemented a *different* ingest path (`walkAndIngest`), so it is unconfirmed whether the file2md→bus→sink wiring was ever delivered.

Decision (grill the human one question at a time): for tickets 05 & 06, choose
- **close as superseded** (if ticket 01 confirms the wiring is delivered or truly obsolete), then archive the effort; or
- **migrate as live** into `2026-08-08-knowledge-pipeline` as fresh build tickets (if the file2md→bus→sink path is still wanted and undelivered).

If migrated, specify the mapping (which canonical ticket number / net-new). This is the cluster's one genuine open judgment call.

## blocked by

01 (code-verification of whether 05/06 were delivered)

## claimed

—

## Resolution (closed 2026-08-12)

Done — 2026-08-01 tickets 05 & 06 closed as superseded (verified delivered in code; nothing migrated).
