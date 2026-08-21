---
effort: 2026-08-16-webui-view-notifications
created: 2026-08-16
last: 2026-08-16
status: specified
---
# webui-view-notifications — notify the browser shell when an extension opens a view

## Destination

When any extension emits `webui:open` (e.g. archify render done), the user is notified BOTH in
the terminal (exists: `ui.notify`) AND in every connected browser shell — via (1) a
`view_opened` WS frame rendered as a fading clickable toast, and (2) a live "views" panel in
the shell listing recent renderings. Scope = toast + panel.

## Context (researched facts)

- **webui:open seam today (unchanged emitter contract)**: payload `{path, view?, title?}` on
  the shared pi.events bus. Handler validates `path` against the same file-roots allowlist +
  containment core as the `/files` route (`locateFileInRoots`), per-segment percent-encodes
  `rel`, builds `url = ${getUrl()}/files/${rootIdx}/${rel}`, then calls `opts.notify`
  (`open-event-handler.ts:96-98`) → `ctx.ui.notify` — **terminal ONLY**; no WS broadcast.
  Injectable opts are `{getUrl, notify}` closures (`open-event-handler.ts:38-42`).
- **Broadcast infra exists**: `Broadcaster` = fire-and-forget fan-out of one `WebFrame` to all
  WS clients (`broadcaster.ts:23-26`); used by `notifier.ts:8-13` (mutex frames) and the wiring
  (message_*/tool_*/snapshot/mutex_* via `toWebFrame`). **No notify/view frame type exists.**
  Every broadcast ALSO appends to the SessionStore transcript ring — `TRANSCRIPT_CAP = 500`
  (`session-store.ts:21-22`; wiring appends at `webui-wiring.ts:296`) — and the newest-500
  replay rides the connect-time `snapshot` frame (`webui-wiring.ts:487`). A new broadcast frame
  type therefore enters replay automatically unless explicitly excluded.
- **WebFrame union** (`protocol.ts:146-174`): enumerated typed members + a final forward-compat
  generic `{type: string; [k: string]: unknown}` — unknown host events pass through verbatim.
- **Browser shell** (`render-shell.ts`, one inline HTML string, no React): WS `/ws` connect at
  `:217-241` — outbound frames dispatched by the `txApply(frame)` switch at `:310-311`; 2s
  retry. SSE `/api/events` `view_update {viewId, updatedAt}` at `:180-201` → tab refresh +
  present-probe. Views fetched via GET `/api/views` **once** at load (`:8`, `:136-137`) →
  `viewSummary {id, title, mode, updatedAt}` (`render-routes.ts:58-60, 77-79`). **Zero toast
  UI, no push-driven list.** Styling precedent for a transient overlay: `#webui-feedback-log`
  (fixed bottom-right, z-50, row cap 50 — `render-shell.ts:253-257`). Existing layout: `#tabs`
  header; `#shell-row` = main + `#btw-panel` aside; `#webui-compose` bottom bar.
- **Shell render sandbox**: both md and html views render inside `<iframe sandbox="">`
  srcdoc — most restrictive, NO scripts (`render-shell.ts:169-177`). The `/files` route exists
  precisely because archify HTML needs top-level `sandbox allow-scripts` (archify decision
  01-A/03) — an in-shell `sandbox=""` iframe of a `/files` URL would neuter its JS runtime.
- **RenderService registry** (`render-service.ts`): in-memory Map, REPLACE-only `render()`
  (never appends); `RenderView {id, mode:"md"|"html", content, title?, controls?, presentId?,
  updatedAt}`; `subscribe(viewId, updatedAt)` listeners; `urlFor(viewId)` composes URLs. A
  `/files`-sourced view (from `webui:open`) has NO content — a URL pointer, not content; the
  registry has no slot for it today.
- **TUI patterns to mirror**: (P1) `core-task/src/subagents/notify.ts:22-42` — diff consecutive
  snapshots → transient line, exactly-once bell, one-tick fade; (P2)
  `subagents-section.ts:62-90` — poll-snapshot widget, 1s refresh only while live, collapses
  when idle; (P3) write-once run records — **deferred here** (persistence is a non-goal).

## Non-goals (user decision 2026-08-16, explicitly deferred)

- Persistence of view history across sessions (P3 run-record analog stays out).
- Rich cost/token tails on views.
- Auto-open a new browser tab on `webui:open` (toast click is the explicit user action).
- TUI-side changes (`ui.notify` terminal line already exists and stays as-is).

## Decisions

| #   | Fork                                                                                             | Decision (2026-08-16)              |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 01  | `view_opened` frame contract — payload shape, event-vs-snapshot semantics, 500-frame replay policy | **B** — `{view?, title?, url}` path-absolute; replay-included with `ts`; client age-gates the toast |
| 02  | Views panel data source — push frames vs poll; registry unification (`/files` views vs render views) | **A** — RenderService `mode:"url"`; SSE/`/api/views`/tabs light up free; sandbox-iframe guardrail; hybrid push + 1s poll backstop |
| 03  | Toast UX rules — click action, duration/stacking/dedupe, mutex-held behavior                       | **B** — focus existing per-URL tab; 7s fade + hover-persist, cap 3, dedupe extends; mutex-held ⇒ still show (display-only) |
| 04  | Panel lifecycle — idle collapse, ordering, affordances, row cap                                    | **C** — newest-first <24h ×8, empty ⇒ collapsed; open/copy/dismiss; localStorage collapse |

### Settled inline (obvious, pre-decided)

- **Terminal notify stays first-class** — the browser notification is ADDITIVE; `opts.notify`
  (`ui.notify`) keeps firing unchanged.
- **`webui:open` emitter contract is untouched** — archify et al. change NOTHING; all new work
  is server-side interpretation + shell UI.
- **`view_opened` gets a TYPED member** in the WebFrame union (not just the generic
  passthrough) so the shell can switch on it and tests can assert round-trip.
- **Broadcast surface via an injectable closure opt** (e.g. `broadcast?(frame)`) on
  `OpenHandlerOptions` or wiring-level composition — never a captured server handle (existing
  closure pattern; `getUrl` is read lazily the same way).
- **No in-tab `/files` render** — archify 01-A stands: `/files` documents open top-level; the
  shell's `sandbox=""` srcdoc iframes cannot carry them. Registry unification (02) is about
  LISTING, not in-tab rendering.
- **Toast is client-side state only** — no server-side toast tracking; dedupe/fade rules live
  in the shell (P1 analog).
- **Failure posture** — broadcast is fire-and-forget (broadcaster contract: must not throw);
  the shell ignores malformed/unknown `view_opened` frames (spec §6 robustness rule).

## Frontier

cleared (decisions 01–04 closed 2026-08-16 — B/A/B/C; `spec.md` written; build tickets 06–08 closed (reviewed: approve))

## Fog of war

Not charted (distant): persisted view history / cross-session "recent renderings" (P3 lineage);
rich cost/token tails; auto-open/new-tab policy beyond toast click; full webui redesign /
TUI-WebUI co-work model (zk-spawn lineage, separate effort); multi-client toast acknowledgement.

## Tickets

| Ticket                     | Type     | Status            | Question                                                        |
| -------------------------- | -------- | ----------------- | --------------------------------------------------------------- |
| `tickets/01-frame-contract.md`      | decision | closed — **B**     | payload `{view?, title?, url}` path-absolute; replay + `ts`; age-gated toast |
| `tickets/02-panel-data-source.md`   | decision | closed — **A**     | RenderService `mode:"url"` unification; push + 1s poll backstop (hybrid) |
| `tickets/03-toast-ux.md`            | decision | closed — **B**     | focus existing per-URL tab; 7s + hover-persist; cap 3; dedupe extends; always show under mutex |
| `tickets/04-panel-lifecycle.md`     | decision | closed — **C**     | newest-first <24h ×8; open/copy URL/dismiss; localStorage collapse |
| `tickets/05-build.md`               | build    | closed — superseded | stub expanded into 06–08 |
| `tickets/06-server-frame-and-registry.md` | task | open      | `view_opened` frame + replay; `mode:"url"` registry + id stability; handler wiring; `/api/views` shape unchanged |
| `tickets/07-shell-toast-and-panel.md`     | task | open      | toast (03-B), views panel (04-C), url-tab routing, poll backstop, age-gate; may parallel 06 |
| `tickets/08-docs-and-e2e.md`              | task | open (blocked-by 06, 07) | README (user-facing + `mode:"url"` author contract), manual E2E smoke script, map status sync |

## Cross-effort links

- Shares-decision-with: `2026-08-15-archify-webui-html` — this effort EXTENDS its `webui:open`
  seam (ticket 06 / decision 01-A top-level opens, 04 view-label scheme) from
  terminal-only announce to browser-shell notification; nothing there is superseded.

## Notes

- **Lineage**: PR #1458 — "feat(webui,archify): full-fidelity /files HTML route + webui:open
  announce" (squash-merged 2026-08-16) — shipped the `webui:open` seam, `/files` route,
  `fileRoots` allowlist, and the per-segment URL encoding this effort builds on.
- **Research mapping** (ground truth embedded by dispatch, re-verified 2026-08-16 against the
  tree): `open-event-handler.ts:96-98` (notify-only seam) · `broadcaster.ts:23-26` (fan-out
  port) · `notifier.ts:8-13` + `protocol.ts:146-174` (frame families; no notify/view type) ·
  `session-store.ts:21-22` + `webui-wiring.ts:296, :487` (500-cap transcript auto-append +
  connect-time replay) · `render-shell.ts:8, :136-137, :180-201, :217-241, :310-311`
  (single-fetch views, SSE view_update, WS dispatch, feedback-log overlay precedent) ·
  `render-routes.ts:58-60, :77-79` (/api/views summary) · `render-service.ts` (replace-only
  registry; no URL-pointer slot) · `core-task/src/subagents/notify.ts:22-42` (P1) ·
  `subagents-section.ts:62-90` (P2).
- **2026-08-16**: decisions grilled and closed (B / A-hybrid / B / C); `spec.md` written
  (status: specified); ticket 05 stub expanded into build tickets 06–08.
