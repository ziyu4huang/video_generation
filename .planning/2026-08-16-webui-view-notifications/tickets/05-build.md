---
ticket: 05-build
effort: webui-view-notifications
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
note: superseded by tickets 06–08 (decisions 01–04 closed 2026-08-16; spec.md written)
---
# 05 — Build: wiring + tests (stub)

## Goal (summary; detail follows decisions 01–04)

Ship the browser-side `webui:open` notification: `view_opened` broadcast + shell toast +
views panel, terminal notify unchanged.

## Touch points (researched; final scope set by 01–04)

- `src/protocol.ts` — typed `view_opened` member in the WebFrame union (+ replay/snapshot
  wiring per 01).
- `src/open-event-handler.ts` — broadcast closure opt (fire-and-forget; ignore-on-error — bus
  robustness rule unchanged); optional registry registration if 02 = A.
- `src/webui-wiring.ts` — pass the broadcaster/session-store closures into the handler;
  replay policy hookup (01 sub-fork 2).
- `src/render-service.ts` + `src/render-routes.ts` — url-pointer view kind + `viewSummary`
  extension if 02 = A.
- `src/render-shell.ts` — frame dispatch case (WS `txApply` and/or SSE per 02 sub-fork), toast
  stack (overlay sibling of `#webui-feedback-log`), views panel section, click/copy/dismiss
  handlers per 03/04.
- Tests: unit (frame round-trip incl. replay; handler broadcasts once and never throws;
  registry replace semantics if 02 = A) + shell-level capture-broadcaster tests; canonical
  package gate `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`.

## Acceptance

- Decisions 01–04 closed; this stub expanded into a real task ticket (or straight to PR per
  effort flow); no scope creep into the non-goals.

## Resolution (2026-08-16)

Decisions 01–04 closed (B / A-hybrid / B / C); `../spec.md` written; this stub expanded into
`06-server-frame-and-registry.md`, `07-shell-toast-and-panel.md`, and `08-docs-and-e2e.md`.
