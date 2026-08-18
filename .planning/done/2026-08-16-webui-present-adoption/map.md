---
effort: webui-present-adoption
created: 2026-08-16
last: 2026-08-16
status: done
---
# webui-present-adoption — make the HITL presentation loop real

## Context
The interactive loop itself is ALREADY BUILT (2026-08-14-build-hitl-webui, done):
`present-tool.ts` exposes the LLM-callable BLOCKING `webui_present` tool
(declarative `{id,label,takesInput}` controls, one-pending guard, abort→cancelled,
no timeout); `present-event-handler.ts` mints present-as-views; the shell renders
the toolbar (`render-shell.ts:696-726`); answers ride the `appexec` respond/cancel
frame bypassing the mutex; mutex watchdog suspends while a presentation pends;
SessionStore snapshots `presentId` for reconnect. What's MISSING: no producer
calls it, TUI-only sessions deadlock (no timeout), core-task ask-user has zero
webui bridging. zk-spawn research extras (structured menus, variants,
region-select) unbuilt — out of scope per D3.

## Decisions (grilled 2026-08-16)
- **D1 Scope — ALL**: producer wiring (archify) + free-text tweak affordance +
  ask-user bridge. One effort closes all three.
- **D2 TUI deadlock — connected-gate**: blocking presentation ONLY while ≥1
  webui client is connected. No client → degrade to non-blocking `ui.notify`
  (surface path, agent continues). Mid-presentation disconnect → auto-release
  (cancelled, reason `no_client`) — never deadlock.
- **D3 Regenerate vocabulary — free-text Tweak**: single `takesInput` control;
  NO structured menus in v1 (Q1 "全部上" reconciled with Q3: menu work dropped).
- **D4 Persistence — ephemeral**: answers ride tool result / injected user turn +
  transcript ring only. Decision-history fog stays on the map.

## Tickets
| Ticket | Type | Status | Summary |
|---|---|---|---|
| `tickets/01-connected-gate.md` | task | closed | connected-gate + mid-flight disconnect auto-release (webui) |
| `tickets/02-archify-present-wiring.md` | task | closed | archify emits `webui:present` (approve/tweak); answers → user-turn injection |
| `tickets/03-ask-user-bridge.md` | task | closed | mirror ask-user questionnaire into shell; route answer back to session |
| `tickets/04-docs-e2e-sync.md` | task | closed | READMEs + E2E + map sync |

## Fog of war (distant)
- persisted decision history / "recent renderings" (D4 deferred)
- structured tweak menus / variants / region-select (zk-spawn extras, D3 deferred)
- MLX image/video producers calling present (post-archify adoption)

## Frontier
Effort complete — all tickets closed; pending review + merge.
