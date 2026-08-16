# webui-event-cards — Effort Map

- Status: active
- Created: 2026-08-16
- Design: approved 2026-08-16 (brainstorming — decisions in spec.md)
- Baseline: origin/main d2047a19 (post #1490 package rename)

## Premise

Chat belongs to the TUI. The webui is the client-end interactive surface: it
focuses on what the browser does best — rich cards, viewers, panels — and
stops duplicating the TUI chat composer.

## Tickets

| # | Ticket | Status | Result |
|---|--------|--------|--------|
| 00 | de-chat: remove main composer, fix btw IME, simplify layout | open | — |
| 01 | card frame contract + Cards tab (projection) | open | — |
| 02 | interactive cards: answer loop + JSONL decision log | open | — |
| 03 | TUI attention bell + #card-<id> deep link | open | — |
| 04 | viewer sandbox: postMessage bridge + user-confirmation gate | open | — |
| 05 | v1 pilot wiring (questionnaire + archify cards) + docs/E2E | open | — |

Absorbed: webui-tui-parity ticket 03 (bus console) → tickets 01/05 here.
