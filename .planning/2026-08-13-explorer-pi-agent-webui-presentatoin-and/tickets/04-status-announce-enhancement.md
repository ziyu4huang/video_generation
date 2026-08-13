---
type: task
status: closed
claimed: explorer-webui
---
## Question

The webui startup status announce shows only a bare URL — a persistent footer line `http://127.0.0.1:<port>` (`ui.setStatus`) plus an ephemeral toast `webui: <url>` (`ui.notify`). The bare-URL footer is uninformative. Enhance it.

## Resolution

The announce fires ONLY when the FIRST CONTENT is rendered (first `registry.render()`), NOT at `session_start` — the webui is a render surface, so announcing before any content exists is noise. (Refined from an initial session_start trigger per user feedback.)

Mechanism: a wiring-level fire-once listener on the registry (`registry.subscribe`, guarded by a local `announced` flag) reads `server.url` + the bound session's `ctx.ui` on the first render and fires:
- **Footer** (`ui.setStatus("webui", …)`): `🌐 webui · <url> · open in browser to view results` — persistent, labeled, actionable.
- **Banner** (`ui.notify(…, "info")`): `webui ready — open <url> in a browser to view rendered results and send feedback. (loopback · no auth)` — one-time context.

Both existing `ctx.ui` surfaces; no new host API, no console.log. `server.url` is safe in the listener (render fires after session_start→server.start()). Tests assert the 3-state behavior: empty after session_start, populated after first render, one-shot (no re-fire on a second render).

Scope: announce UX/timing only — orthogonal to the image renderer (#02) and the shell feedback toolbar (#03).
