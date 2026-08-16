---
status: closed
---
# 01 — card frame contract + Cards tab (projection)

## Tasks
1. protocol.ts: add `card` frame to the outbound union (contract in spec.md).
2. render-shell.ts: Cards tab in the header tab strip; renders projected card
   frames (live + replay). Readonly body = pre-rendered segments — textContent
   or escHtml only, never raw HTML injection.
3. webui-wiring.ts: bus snoop per spec (wrap pi.events.emit; forward
   non-OUTBOUND_EVENTS as readonly cards, attention silent).
4. Tests: frame contract + replay (snapshot → Cards tab shows cards).

## Acceptance
- Card frames replay from the snapshot store; tab survives refresh; XSS-safe.

## Result
01: card outbound-union frame (id/kind/title/source/ts/attention/body.text); Cards tab + pane projecting card frames live + via snapshot replay (textContent-only render); bus snoop wraps host events.emit forwarding non-OUTBOUND (excl webui:render) as silent readonly cards; dispose restores emit; webui 486/0.
