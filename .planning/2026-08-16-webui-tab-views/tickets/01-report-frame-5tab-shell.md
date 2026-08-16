status: open

# 01 — report frame + 5-tab shell + routing + md renderer

Steps:
1. protocol.ts: report frame type (D2 shape; validate exactly-one-of markdown|html on the OUTBOUND side the same way card frames are shaped; no inbound).
2. session-store.ts: append accepts report; cap-exempt list = card, card_done, report.
3. render-shell.ts: header tabs → five buttons (Transcript default active); panes: #report-pane, #ask-pane, #events-pane (rename of cards-pane internals), #data-pane (transcript stays the main). txApply routing per spec D1: ask-* → ask pane; viewer → data pane row; else events. card_done routed by owner pane. report frame → md renderer (createElement/textContent only; html → sandbox iframe srcdoc property). Cards tab id/history: keep #cards-pane as the Events pane (rename id to events-pane; update CSS + tests referencing it).
4. Tests: report frame renders md (h1/p/li via DOM assertions); html report → iframe sandbox allow-scripts + no allow-same-origin; card routing (ask card lands in ask pane; viewer card row in data pane; readonly card in events pane); card_done retires in the OWNING pane; store cap-exempt covers report.
Acceptance: typecheck clean; webui 0 fail REAL lines (>482); innerHTML ≤ 8.
