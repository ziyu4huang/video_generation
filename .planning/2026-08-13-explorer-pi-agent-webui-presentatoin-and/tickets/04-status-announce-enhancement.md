---
type: task
status: closed
claimed: explorer-webui
---
## Question

The webui startup status announce shows only a bare URL — a persistent footer line `http://127.0.0.1:<port>` (`ui.setStatus`) plus an ephemeral toast `webui: <url>` (`ui.notify`). The bare-URL footer is uninformative. Enhance it.

## Resolution

Enrich BOTH announce calls in the `session_start` handler (`src/webui-wiring.ts`), chosen option = **Footer + startup banner** (informative persistent footer + one-time banner; both existing `ctx.ui` surfaces, no new host API, no console.log):

- **Footer** (`ui.setStatus("webui", …)`): `🌐 webui · <url> · open in browser to view results` — persistent, labeled, actionable.
- **Banner** (`ui.notify(…, "info")`): `webui ready — open <url> in a browser to view rendered results and send feedback. (loopback · no auth)` — one-time context.

Updated the announce-pinning tests in lockstep: `tests/webui-wiring.test.ts` and `tests/wiring-live-smoke.test.ts` (blocks G + H; H switched `.toBe(url)` → `.toContain(url)` to express URL-embedding intent, not banner prose). 226 tests green.

Scope: announce UX only — orthogonal to the image renderer (#02) and the shell feedback toolbar (#03).
