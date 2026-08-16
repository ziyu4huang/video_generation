---
status: closed
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

## Result
04 (simplified per user): viewer cards render in sandbox="allow-scripts" iframes (no same-origin) with an injected webui.emit→postMessage shim; host listener wraps every emit into a local confirm card (payload shown as text) — Approve rides the t02 card_answer loop (JSONL + card_done), Deny discards; security intentionally minimal (no origin allowlist/CSP additions/anti-spoof tests); webui 510/0.
