# webui-tab-views

## Destination

Replace the single Cards surface with semantic tabs: Transcript (agent stream, unchanged) + Report (static md/html reports by agent/skill) + Ask (questionnaire queue + answered history) + Events (general readonly cards, the old Cards tab) + Data (interactive HTML viewer rows + full-pane sandbox).

- Status: active
- Decisions:
  - D1 five tabs; ask cards (id ask-*) route to Ask; viewer cards (kind viewer) route to Data; everything else stays in Events.
  - D2 new outbound frame `report` {type:"report", id, title, markdown?|html?, source, ts} — producers broadcast via a wiring helper export; Report tab renders markdown via a minimal createElement/textContent renderer; html mode renders in a sandbox="allow-scripts" iframe (srcdoc, NO allow-same-origin).
  - D3 Ask tab = pending form(s) at top + answered history below (collapsible review from answers-bearing card_done, cards-ux2 04).
  - D4 Data tab = viewer-card rows; click opens the sandbox iframe FULL-PANE in the tab. webui.emit bridge + confirm gate unchanged.
  - D5 deep links generalize: #card-<id> activates the OWNING tab then scrolls/flashes (t03 handleCardHash extended); bell message unchanged.
  - D6 session store append accepts report frames; report frames are card-exempt like card/card_done (never evicted by cap).
- Tickets:
  | # | ticket | status | result |
  | 01 | report frame + 5-tab shell + routing + md renderer | closed | five tabs + routing + md renderer; webui 489/0 |
  | 02 | report producer helper + Data full-pane + deep-link routing + README | open | — |
