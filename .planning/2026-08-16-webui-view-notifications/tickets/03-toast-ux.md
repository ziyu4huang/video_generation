---
ticket: 03-toast-ux
effort: webui-view-notifications
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocking: [04, 05]
---
# 03 — Toast UX rules: click, duration/stacking, mutex-held behavior

## Question

What does clicking the toast do, how long do toasts live / stack / dedupe, and what happens
while co-driving (mutex held by the other frontend)?

## Options — click action

- **(A) click opens a top-level tab** (`window.open(url)` / `target="_blank"`), no tab
  tracking. Consistent with archify 01-A ("top-level browser document") and the terminal
  notify line's click affordance.
  - Impact: simplest; repeated clicks can stack duplicate tabs (browser-dependent).
- **(B) click focuses an existing tab for the same URL** — client keeps `window.open` handles,
  re-uses + `.focus()` while `!closed`, else opens new.
  - Impact: nicer; costs handle bookkeeping, named-window re-lookup, popup-blocker and
    focus-permission quirks across browsers.

### Sub-fork 1 — duration / stacking / dedupe

- Duration: P1 one-tick fade analog (next snapshot tick clears) vs fixed ms (e.g. 6–8s) vs
  fixed ms + hover/pointer-over persists. Hover-persist costs pointer listeners; P1 analog
  depends on a "next tick" the browser shell does not natively have (needs a timer anyway).
- Stacking: last-N cap for simultaneous toasts (e.g. 3–5), oldest dropped — mirrors the
  `#webui-feedback-log` 50-row cap precedent, but toasts are far more visual so smaller.
- Dedupe: same `view` re-opened while its toast is up → refresh/extend the existing toast
  (P1 exactly-once analog), never stack a second.

### Sub-fork 2 — while co-driving (mutex-held)

Mutex signals already reach the client (`mutex_blocked` / `mutex_force_release` frames), and
the mutex gates INPUT (agentic frames), not display — precedent: message_*/tool_* frames
stream into the transcript and SSE view_update refreshes tabs regardless of driver. Fork:
toasts always show (display-only, never steal focus — default lean) vs suppress toasts while
`mutex_blocked` by the OTHER driver (only relevant if toasts were deemed distracting during
co-driving). No toast action ever acquires the mutex (opening a /files URL is not input).

## Acceptance

- Click action, duration, cap, dedupe rule, and mutex-held rule each decided and stated for
  ticket 05 as testable shell behaviors.
- No rule requires server-side toast state (settled inline: toast is client-side only).

## Decision (2026-08-16)

**B** — toast click focuses an EXISTING per-URL window handle (`window.open` first time,
`.focus()` after while `!closed`; no duplicate tabs). Defaults: 7s auto-fade (6–8s band) +
hover-persist; stack cap 3 (oldest dropped); same-view dedupe extends the live toast instead
of stacking. Mutex-held: toasts always show — display-only, never steal focus, never acquire
the mutex. See `../spec.md` §Decisions · 03.
