---
status: open
---
# 03 — TUI attention bell + #card-<id> deep link

## Tasks
1. attention `input`/`view` cards raise a TUI notify bell (respect the user's
   bell setting) with a message containing the card id.
2. Deep link: webui routes `#card-<id>` → opens Cards tab, scrolls to card,
   flashes highlight.
3. Tests: attention routing + hash navigation (incl. cold load).

## Acceptance
- Silent cards never bell; `#card-<id>` lands on the card from a cold load.
