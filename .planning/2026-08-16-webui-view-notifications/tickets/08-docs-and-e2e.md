---
ticket: 08-docs-and-e2e
effort: webui-view-notifications
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocked-by: [06, 07]
blocking: none
---
# 08 — Docs + E2E smoke + map sync

## Goal

User-facing docs, a manual E2E smoke script, and effort-map status sync after 06 + 07 land.

## Work

- **README (webui):** document the toast + views panel user-facing behavior — fresh-only
  toast (replayed frames never re-toast), ~7s fade + hover-persist, stack cap 3,
  click-to-focus-existing-tab; panel 24h×8 newest-first with open / copy URL / dismiss and
  localStorage-persisted collapse. Also document the `mode:"url"` contract for extension
  authors: emit `webui:open {path, view?, title?}` (unchanged); the registry id derives from
  `view` (fallback: the url), so re-opening the same `view` updates rather than duplicates;
  everything else is server + shell work.
- **Manual E2E smoke script** (documented steps or a scripts/ snippet) using the headless
  `Bun.serve` demo pattern from 2026-08-15: set `WEBUI_FILE_ROOTS`, run an archify render,
  then observe —
  1. toast appears exactly once and fades ~7s; hovering holds it;
  2. toast click opens the `/files/...` document top-level; a second open focuses the same
     tab (no duplicate);
  3. panel row appears; a re-open floats it to top and extends the live toast;
  4. page refresh repopulates the panel (replayed frames + `/api/views`) but fires NO toasts;
  5. panel collapse persists across reload (localStorage);
  6. while the panel is expanded, `/api/views` polls at 1s (backstop); collapsed ⇒ no polls.
- **map.md status sync:** tickets 06/07/08 → closed; effort status → built/shipped per the
  effort flow.

## Gate

`( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )` green + smoke steps
recorded in the ticket or PR.

## Result
08: view-opened-e2e.test.ts (9 expects) + README (webui + archify) + planning sync; gate 463 pass / 0 fail.
