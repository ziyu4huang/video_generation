---
effort: 2026-08-16-webui-v3-simplify
created: 2026-08-16
status: active
---

# Map: webui v3 — simplify + co-work with TUI

## Destination

A lean webui that is a PURE HITL companion to the agent TUI (the TUI owns logs):
no transcript, no tool-log lines, three tabs (Inbox / Report / Data), plus a
dedicated `webui` audit tool in power-tool that renders automated visual/design
verification a single tool call away.

## Decisions (user-ratified 2026-08-16)

- D1 Transcript REMOVED entirely — webui = pure HITL surface; agent text + tool
  logs live in the TUI. Web clients stop RECEIVING log frames (source diet).
- D2 Taxonomy = 3 tabs: Inbox (ask cards + event/readonly cards merged),
  Report (static md/html reports), Data (viewer interactive HTML).
- D3 Debug tool = dedicated `webui` tool in pi-agent-ext-power-tool: one call →
  live port connect, tab/pane/card DOM outline, per-tab screenshots,
  console/page errors, design-invariant checks, audit report. Built on the
  browser-tool engine (headless system Chrome).
- D4 Depth = source-level diet: frame allowlist at the wiring (web clients get
  card/card_done/report/ask_user/ask_user_done/appexec/session_info/view_opened/
  snapshot/error/mutex only), store trims to the same set, shell rebuilt lean.

## Tickets

| # | title | status | result |
|---|---|---|---|
| 01 | `webui` audit tool in power-tool | closed | tool + 6 invariants + per-tab screenshots; gates green |
| 02 | frame diet: wiring allowlist + store trim | open | — |
| 03 | shell rebuild: 3 tabs, transcript gone | open | — |
| 04 | README + docs + map close | open | — |

## Notes

- Do t01 FIRST (instrument before surgery — it verifies t02/t03).
- Present surface (#content + appexec respond/cancel + SSE focus) is KEPT.
- Bell + #card-<id> deep links KEPT (route to owning tab).
- Eviction/cap logic may simplify away entirely if the store only holds sparse
  interactive frames (t02 to verify).
