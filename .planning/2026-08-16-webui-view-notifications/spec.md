---
effort: webui-view-notifications
status: specified
created: 2026-08-16
last: 2026-08-16
---

# spec — webui-view-notifications

## Goal

When any extension emits `webui:open`, the user is notified in the terminal (existing
`ui.notify`, unchanged) AND in every connected browser shell: a fading, clickable toast
(fresh events only) plus a persistent "views" panel listing recent renderings. `/files`-origin
views become first-class registry entries (`mode:"url"`) so tabs, SSE updates, and `/api/views`
light up for free. Scope = server frame + registry + shell toast + panel; nothing else.

## Decisions

### 01 — `view_opened` frame contract → **B**

Payload `{view?, title?, url}` where `url` is **path-absolute** (`/files/<rootIdx>/<rel>`,
per-segment percent-encoded server-side exactly as today); the client joins
`location.origin + url`. Encoding authority stays 100% server-side (one place — preserves the
PR #1458 review fix); frames stay portable across port walks and replay.

- **Sub-fork 1 (event vs snapshot):** state-bearing event — a typed WebFrame union member
  `{type:"view_opened", view?, title?, url, ts}` that rides BOTH live broadcast and the
  connect-time replay (replay inclusion is what gives it snapshot value).
- **Sub-fork 2 (replay):** **include in the 500-frame ring, carrying `ts`**; the client
  age-gates the TOAST — replayed/stale frames update the panel but never re-toast. Chosen over
  store-exclusion (would starve the panel of history on refresh) and raw inclusion (re-toast
  spam on every reconnect).

### 02 — Panel data source + registry → **A (hybrid transport)**

Unify in RenderService: new view kind `mode:"url"` (URL pointer; `content` not required for
it). The open-event handler registers the view; the existing `view_update` SSE, `/api/views`,
and the `#tabs` machinery light up for free. Panel transport = **push + poll backstop**:
the WS `view_opened` frame drives the toast AND the panel immediately; while the panel is
expanded the client also polls `/api/views` at 1s (P2 analog) as a correctness backstop
(catches entries whose frames fell out of the 500-ring or were never seen by this client).

- **Guardrail (settled inline, restated):** a `mode:"url"` view's tab click must NEVER route
  into the `sandbox=""` srcdoc iframe — it takes the 03-B top-level open/focus action instead.
- **Id stability:** same view re-opened UPDATES (bumps `updatedAt`), never duplicates —
  registry id derived from the view name: `url:<view>` when the payload carries `view`, else
  `url:<url>` (the path-absolute url is itself stable per rendered file).
- **Refresh behavior:** a mid-session reload re-receives replayed `view_opened` frames (panel
  repopulates silently; no toasts) and re-fetches `/api/views` once at load, as today.

### 03 — Toast UX → **B**

Toast click focuses an EXISTING per-URL window handle: first click for a URL does
`window.open(url)`; subsequent clicks reuse the handle (`.focus()`) while `!closed`, else open
a new one — never duplicate tabs.

- **Defaults (sub-fork 1):** auto-fade after **7s** (6–8s band) with **hover-persist**
  (pointer-over pauses the fade); simultaneous stack cap **3**, oldest dropped (feedback-log
  cap precedent, smaller because toasts are more visual); same-view dedupe — a re-open while
  its toast is up **extends/refreshes** that toast instead of stacking a second.
- **Sub-fork 2 (mutex-held):** toasts ALWAYS show while co-driving — display-only, never
  steals focus, and no toast action ever acquires the mutex (opening a `/files` URL is not
  input). Matches the precedent that display frames flow regardless of driver.

### 04 — Panel lifecycle → **C**

Newest-first list of entries younger than **24h**, capped at **8** rows; an empty window ⇒
panel collapsed. A re-open floats the entry back to the top (bumps `updatedAt`; newest-first
ordering).

- **Affordances per row:** `open` (row click → the SAME 03-B handler as the toast), `copy URL`
  (`navigator.clipboard` — loopback origin is a secure context), `dismiss` (client-side-only
  removal overlay; the server list is untouched).
- **Collapse state persisted** in localStorage, following the `btw-panel-collapsed` precedent.

## Design

End-to-end flow (line-numbered grounding lives in map.md; nothing here changes the emitter):

1. **Extension emits `webui:open`** `{path, view?, title?}` on the shared pi.events bus —
   unchanged contract (archify et al. touch nothing).
2. **open-event-handler** validates `path` against the file-roots allowlist
   (`locateFileInRoots`), composes the path-absolute url `/files/<rootIdx>/<rel>` with the
   existing per-segment encoding, and now — in addition to the unchanged `opts.notify`
   terminal line — **registers** a `mode:"url"` view in RenderService (id per the 02
   id-stability rule; `title` normalized to `string | null`) and **broadcasts** one
   `view_opened` WebFrame `{view?, title?, url, ts}` via the injectable broadcast closure
   (fire-and-forget; broadcaster must not throw).
3. **Server push** — the broadcast fans out to all WS clients AND appends to the SessionStore
   transcript ring via the existing store-wrapper (TRANSCRIPT_CAP 500), so the frame is
   replay-included with its `ts` at connect time automatically. RenderService's `subscribe`
   also fires `view_update {viewId, updatedAt}` on the SSE channel exactly as for any render
   — tab refresh + present-probe light up free.
4. **Shell (render-shell.ts)** —
   - **dispatch:** new `view_opened` case in the WS `txApply(frame)` switch.
   - **age-gate:** toast iff `now - ts < TOAST_FRESH_MS` (default 10s; same-machine loopback,
     so clock skew is a non-issue) — replayed/stale frames update the panel only.
   - **toast stack (03-B):** overlay sibling of `#webui-feedback-log`; 7s auto-fade +
     hover-persist, cap 3, same-view dedupe extends; click → per-URL window handle
     (`window.open` once, `.focus()` after) — mutex state never consulted.
   - **views panel (04-C):** newest-first, <24h, cap 8, empty ⇒ collapsed; rows carry
     open / copy URL / dismiss; collapse persisted in localStorage. Row identity is the
     registry id; the id→url map is fed by `view_opened` frames (live + replay) — a row whose
     url is unknown (poll-only discovery) renders title-only with open/copy disabled.
   - **tab click on a `mode:"url"` view:** routed to the SAME top-level open/focus handler as
     the toast — never into the `sandbox=""` srcdoc iframe.
   - **poll backstop:** while the panel is expanded, GET `/api/views` every 1s; collapsed ⇒
     no polling. `/api/views` shape is unchanged (`viewSummary {id, title, mode, updatedAt}`;
     `mode` now includes `"url"`) — the url itself travels only in the frame payload.
5. **Registry semantics** — `render()` on an existing `mode:"url"` id replaces/bumps
   `updatedAt` (the replace-only registry is already the semantics we want); re-open therefore
   floats the panel entry and extends any live toast. In-memory, per-session (persistence is
   a non-goal).

## Testing

- **Unit (server):**
  - Frame contract: `view_opened` typed member round-trips through broadcaster + store
    append; replay includes it with `ts` intact; malformed/unknown frames remain ignored by
    the shell dispatch path (robustness rule unchanged).
  - Registry id-stability: same `view` (or same url when `view` is absent) re-open → one
    entry, bumped `updatedAt`, `listViews()` length stable; different views → distinct ids.
  - `viewSummary` for url views: `mode:"url"`, `title: string | null` normalization;
    `/api/views` response shape unchanged.
- **Unit (client logic, headless where testable — mirror the existing render-shell test
  approach):** 24h×8 windowing as pure functions (age filter, cap, newest-first,
  float-to-top on re-open); age-gate (fresh → toast, stale → panel-only); toast defaults
  (7s fade + hover-persist, cap 3, dedupe-extends); panel collapse persistence key.
- **Integration:** one `webui:open` event → registry entry present, exactly one broadcast
  fired, `opts.notify` still called exactly as before (terminal line unchanged);
  out-of-allowlist path → no registry entry, no broadcast, no throw.
- **E2E (manual smoke, ticket 08):** headless `Bun.serve` demo per the 2026-08-15 pattern —
  `WEBUI_FILE_ROOTS` + an archify render → observe toast appears once and fades ~7s; click
  opens `/files/...` top-level; second open focuses the same tab; panel row present and
  floats on re-open; refresh repopulates the panel but fires NO toasts.
- **Gate:** `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`.

## Non-goals

- Persistence of view history to disk / across sessions.
- Rich cost/token tails on views.
- Auto-open a browser tab on `webui:open` (toast/row click is the explicit user action).
- TUI-side changes (`ui.notify` terminal line stays as-is).
- In-tab `/files` rendering (archify 01-A stands; sandbox-iframe guardrail above).
- Server-side toast state; multi-client toast acknowledgement.

## Open questions

None — decisions 01–04 closed 2026-08-16; build tickets 06–08 carry the implementation.
