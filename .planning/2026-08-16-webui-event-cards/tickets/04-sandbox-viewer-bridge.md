---
status: open
---
# 04 — viewer sandbox: postMessage bridge + user-confirmation gate

## Tasks
1. Viewer cards render body.html in `<iframe sandbox="allow-scripts">` (NO
   allow-same-origin) with strict CSP.
2. In-frame `webui.emit(payload)` → postMessage → host wraps payload into a
   CONFIRM CARD (interactive, attention input) — nothing reaches the bus
   without explicit user confirmation.
3. Confirmed emit → existing appexec answer path (ticket 02).
4. Tests: bridge protocol (origin check, schema); gate not bypassable by
   spoofed postMessage.

## Acceptance
- Unconfirmed emits never leave the browser; sandbox cannot touch parent DOM.
