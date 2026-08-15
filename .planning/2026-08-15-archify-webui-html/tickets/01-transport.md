---
ticket: 01-transport
effort: archify-webui-html
type: decision
status: closed
created: 2026-08-15
last: 2026-08-16
blocking: [02, 03]
---
# 01 — Transport: how does archify HTML reach the browser?

## Question

How does archify HTML reach the browser?

Options:

- **(A) webui serves full-fidelity HTML files** — new file-serving route (top-level browser
  tab, scripts allowed, loopback-guarded); archify render ends by announcing/opening the URL.
  Full interactivity (theme/nav/export). Requires security ticket 03.
- **(B) static inline-SVG webui view** — extract the inline `<svg>` from archify HTML, emit
  `webui:render {mode:"html"}`. Zero webui changes beyond archify-side emitter; fully
  sandbox-safe; loses theme toggle/nav/export.
- **(C) hybrid (recommended per zk-spawn research)** — sandboxed static-SVG preview view in
  webui + shell-hosted "Open full HTML" affordance linking to a new full-fidelity route.

## Decision

**A — full-fidelity file route.** webui serves full-fidelity HTML via a new file-serving
route, opened as a top-level browser tab (scripts allowed, loopback-guarded). archify render
ends by announcing the URL via the new `webui:open` event (ticket 02).

Rationale: archify's JS runtime — theme toggle, semantic nav, PNG/SVG/WebM export menu — **is
the product**; a static-SVG view (option B) would gut it, and option C's hybrid adds a second
surface to build/maintain for little gain when the shell tab already gives a safe preview.
Security posture is delegated to ticket 03 (CSP `sandbox allow-scripts` + configured directory
allowlist).

## Acceptance

- Decision recorded with rationale.
- Downstream tickets 02/03 unblocked.
