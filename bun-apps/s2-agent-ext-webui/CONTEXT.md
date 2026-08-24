# s2-agent-ext-webui

The ubiquitous language of `@repo/s2-agent-ext-webui` — the embedded loopback
webui that co-drives one `AgentSession` with the TUI behind an agentic mutex.
Since v3 the premise is fixed: **the TUI owns the conversation and tool logs;
the webui owns INTERACTION** (ask cards, reports, diagrams, data views) — never
a transcript mirror. Usage/how-to: README; decisions: `docs/architecture-v2.md`
/ `docs/architecture-v3.md` (v3 supersedes; decision log in
`.planning/done/2026-08-16-webui-v3-simplify/`).

## Language

### Premise

**Pure HITL companion**:
The v3 stance — the browser surface does interaction ONLY (Inbox / Report /
Diagram / Data tabs); the conversation and tool logs stay in the TUI. v2's
transcript scrollback was deleted, not hidden.
_Avoid_: web mirror, remote UI (it is an interaction companion, not a copy of the TUI)

**Agentic mutex**:
The lock guaranteeing only ONE surface (TUI or browser) drives the single
`AgentSession` at a time; `mutex_blocked` / `mutex_force_release` frames carry
its state to web clients.
_Avoid_: session lock, turn queue (it arbitrates between DRIVER surfaces, not between turns)

### Protocol

**Frame**:
The unit of server→client payload over the WebSocket, grouped into families
(`card`, `report`, `ask_user`, `message_*`, `tool_execution_*`, …).
_Avoid_: message, event (a frame is the wire-level envelope; agents emit events, the webui frames them)

**Announce channels (`webui:open` / `webui:deck` / `webui:present`)**:
The INBOUND host-bus contract (archify-webui-decouple D2, 2026-08-25): the
webui subscribes string-literal channels on `pi.events` — `webui:open` /
`webui:deck` at `webui-wiring.ts` (open + deck handlers), `webui:present` via
the present handler wrapper — and the emitter today is archify alone
(`archify/src/open-announce.ts`), announcing renders, decks, and HITL views.
Zero imports either direction: archify never imports this package, this
package never imports archify; disabling either side degrades, never crashes.
_Avoid_: renaming the channels (the replay path passes them by name — a rename strands every replayed event), webui-owned events (the data flow is INBOUND: emitters announce, the webui subscribes)

**Frame diet**:
The v3-at-the-source rule: the wiring subscribes ONLY the HITL frame families —
log families (`message_*`, `tool_execution_*`, `tool_result`, `turn_*`,
`agent_settled`, `session_*compact`) never reach the wire, store, or shell. The
bus-snoop SKIP set is deliberately decoupled from the diet.
_Avoid_: filtering, allowlist (the diet is enforced at SUBSCRIPTION, not by dropping frames mid-flight)

**Replay-eligible frame**:
A frame persisted (jsonl mirror; newest 25 reload at boot via store-append — no
broadcast, no bell) so a refresh/restart restores state (reports, ask cards).
_Avoid_: cached frame, persisted state (replay-eligibility is a per-family contract, not a cache policy)

### Inbox

**Ask card**:
The Inbox card rendering a HITL questionnaire (quick-pick) whose answer rides
the ask-user bridge back as a user turn; answered cards collapse into reviewable
summaries. `#card-<id>` deep links activate the owning tab.
_Avoid_: prompt dialog, form (it is the async HITL card, not a blocking form)

**`webui:present`**:
The producer convention — ANY extension may emit `webui:present` to surface
controls (Approve / Regenerate…); event-originated answers arrive as injected
user turns (`[webui:present] "<title>": approved | tweak: "<text>"`).
_Avoid_: notification, toast (it is a HITL control surface with answers injected as turns, not a display event)

**Connected-gate**:
Zero connected clients ⇒ `webui_present` resolves `{skipped:"no_client"}`
immediately and a mid-wait disconnect auto-releases `{cancelled:true}` — TUI-only
sessions never deadlock on a browser that isn't there.
_Avoid_: timeout, fallback (it is a liveness precondition, not a retry policy)

### Reports

**Report producers (two doors, one archive)**:
The `webui_report` tool (in-process, zero sockets, core/always-on) and
`POST /api/report` (external, loopback, origin-guarded) — identical frames by
construction via the shared `report-frame.ts` (title 1–200, exactly one body
mode, 16MB cap).
_Avoid_: report API, publish endpoint (there are exactly two doors and one shared frame contract — name them together)

**Standalone door**:
`GET /api/report/<id>/raw` — a report's HTML as a TOP-LEVEL document under the
/files CSP, the escape hatch for what a `sandbox="allow-scripts
allow-downloads"` iframe's OPAQUE origin cannot do (parent-side measurement,
working export menus). Fullscreen does NOT change sandbox flags.
_Avoid_: raw endpoint, download link (it exists because of the opaque-origin limitation — that why is the term's content)

### Verification

**Clean-boot contract**:
Zero console errors on a clean boot: an empty main view slot answers 204 (a
state, not a missing resource) and the shell head suppresses the favicon
request.
_Avoid_: no-errors check (it is a designed contract — 204-not-404 and the favicon suppression are its mechanism)

**`webui` audit**:
The power-tool verification: 7 invariants (`panes-exclusive`,
`ask-cards-located`, `viewer-cards-located`, `report-articles-located`,
`report-iframe-sized`, `zero-page-errors`, `zero-console-errors`) checked with
real headless Chrome, screenshots per tab, dogfood publish (the audit POSTs its
own report into the audited webui's Report tab).
_Avoid_: e2e test, smoke test (it is the 7-invariant audit over real Chrome with a dogfood publish, not a route ping)
