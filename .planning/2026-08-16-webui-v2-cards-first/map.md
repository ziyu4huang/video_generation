# webui-v2-cards-first

Goal: finish the de-chat philosophy. Webui = Transcript (clean read-only log) + Cards (interactive surface). Remove everything that duplicates TUI or clutters: btw sidebar, views list panel, TURN dividers, meta panel.

- Status: active
- Decisions:
  - D1 cards-first two-pane: tabs = Transcript + Cards only.
  - D2 views surface ONLY as cards (archify url cards, shipped event-cards 05). The floating views list panel is DELETED. #content stays as the PRESENTATION surface: present (blocking HITL) views still auto-focus there with their Approve/controls bar (existing sendAppexecResponse / cancel envelopes, unchanged).
  - D3 btw webui-surface removed entirely (sidebar, /api/btw routes, inbound case, btw-channels/store/routes files, shell JS). pi-agent-ext-btw package UNTOUCHED — TUI /btw keeps working; its idle webui bridge is harmless.
  - D4 transcript keeps frames; drops .tx-turn dividers and #meta panel. session-status chip stays.
- Tickets:
  | # | ticket | status | result |
  | 01 | de-btw + de-clutter (sidebar, views list panel, TURN, meta) | closed | — |
  | 02 | verify + polish: replay/UX checks post-removal, README v2 section | open | — |
