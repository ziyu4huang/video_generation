---
ticket: 07-shell-toast-and-panel
effort: webui-view-notifications
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocked-by: none
blocking: [08]
note: may run in parallel with 06 against the spec contract (frame payload per spec 01-B)
---
# 07 — Shell: toast + views panel (render-shell)

## Goal

Client half of `../spec.md` in `src/render-shell.ts`: toast stack, views panel, url-view tab
routing, poll backstop, age-gate. Decisions 03-B / 04-C + the 02-A sandbox guardrail — see
`../spec.md` §Decisions.

## Work

- **Toast component (03-B):** overlay sibling of `#webui-feedback-log`; 7s auto-fade +
  hover-persist (pointer-over pauses the fade); stack cap 3 (oldest dropped); same-view
  dedupe extends the live toast instead of stacking; click → per-URL window handle
  (`window.open` first time, `.focus()` after while `!closed` — no duplicate tabs).
  Mutex-held: toasts always show — display-only, never steal focus, never acquire mutex.
- **Views panel (04-C):** newest-first, entries <24h, cap 8, empty ⇒ collapsed; re-open
  floats the entry to top; row affordances open / copy URL (`navigator.clipboard` — loopback
  is a secure context) / dismiss (client-side-only overlay); collapse state persisted in
  localStorage (`btw-panel-collapsed` precedent). Row identity = registry id; id→url map fed
  by `view_opened` frames (live + replay); a row whose url is unknown (poll-only discovery)
  renders title-only with open/copy disabled.
- **Tab click routing (02-A guardrail):** `mode:"url"` tabs NEVER render in the `sandbox=""`
  srcdoc iframe — route to the same top-level open/focus handler as the toast click.
- **Poll backstop:** GET `/api/views` every 1s while the panel is expanded; no polling while
  collapsed (P2 analog).
- **Age-gate:** toast iff `now - ts < TOAST_FRESH_MS` (default 10s, same-machine loopback);
  stale/replayed frames update the panel only.
- **WS dispatch:** `view_opened` case in the `txApply(frame)` switch.

## Tests

Headless client-logic tests mirroring the existing render-shell test approach: 24h×8
windowing (age filter, cap, newest-first, float-to-top) as pure functions; age-gate
fresh/stale split; toast defaults (7s fade + hover-persist, cap 3, dedupe-extends);
collapse persistence key. Gate: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`.

## Result
07: shell toast (03-B) + views panel (04-C) + url-tab routing; 29 new tests; gate 462 pass / 0 fail.
