# webui-btw-branch — BTW tab + Data telemetry demo (+ full-bleed scrollbar fix)

## Destination

Answer the user asks of 2026-08-18 in the webui: (1) full-bleed scrollbar fix — panes span the viewport, the 1500px reading cap moves to the content layer; (2) a Data tab view scenario demo — what "Data" can serve; (3) a BTW-tab concept demo — use current content to start a branch chat question, ask_user-style.

## Why

User asks (2026-08-18): (1) why is the Report tab scrollbar inset from the
browser edge; (2) design a Data tab view scenario — what can "Data" serve;
(3) demo a BTW-tab concept: use current content to start a branch chat
question, ask_user-style.

## What shipped

- **Full-bleed scroll** (#1624): root cause `main{padding:1rem;max-width:
  1500px;margin:0 auto}` insetting every pane scrollbar. Fix: panes span the
  viewport; the 1500px reading cap moved to the content layer. Measured live:
  pane right edge == viewport width. Stylesheet-contract test pins it.
- **BTW tab** (this PR): branch-question queue, webui → agent (reverse of ask
  cards). Composer (context picker seeded from Report articles + question +
  hint chips) → `POST /api/btw` → pending list polls (4s, visibility-gated) →
  agent drains via webui tool `{mode:"btw"}` (fetch-only, no browser) →
  answers in chat → `POST /api/btw/<id>/resolve` (or the tab button). Event
  mirror `btw-<port>.jsonl` (create/resolve lines, best-effort, replays at
  boot; cap 200 events). `btw-store.ts` copies the report-persist contract.
- **Data tab demo**: `GET /api/data/summary` telemetry card (port, uptime,
  mirror sizes, pending BTWs), refreshed on tab activation; scenario roadmap
  (telemetry · frame explorer · artifacts registry · ask analytics) in README.

## Verification

webui 523/0 (btw routes lifecycle + bad-body 400s + data summary + store
mirror-replay + buildBtwEntry validation); power-tool 261/0/4skip (btw mode
lists entries with context + hints + resolve hint). Live demo on :8891
(standalone WebServer + routes, headless Chrome): 4 tabs, pane right ==
innerWidth, queue→pending(chips)→resolve flow, telemetry card, 0 console
errors; demo report w/ 3 screenshots published to the live :8890 Report tab.

## Follow-up: loop closure (user "it seems no works")

Automated debug (Playwright on the live :8890): shell current, composer
functional, pending EMPTY, mirror absent — the user never completed a queue.
Root cause = loop not closed: nothing told the agent a question waited, and no
badge showed state. Fix (verified live on :8891): (1) onBtwCreate route hook →
wiring rings the TUI bell (btwBellMessage mirrors cardBellMessage — the agent
learns without polling); (2) BTW tab badge from any tab (15s visibility-gated
poll; 4s detail poll on-pane); (3) how-to copy in the empty state + "agent was
belled" on pending cards. webui 526/0.

## Follow-up 2: hash-addressable panes (user: why not separate pages?)

Design answer recorded: single page keeps ONE live SSE/WS subscription (no
frame loss mid-switch for the HITL inbox), cross-tab BTW badge state, and
zero-latency pane switches; the share/export case already has the standalone
/raw door. The MPA wins (shareable URLs, back/forward, refresh-stable) ship
as hash routing instead: #inbox/#report/#data/#btw; #card-<id> keeps
precedence (pane sync never clobbers a card hash); collapsed state clears the
hash via replaceState. Verified live on :8891: deep-link load, click->URL
sync, goBack->pane restore, reload keeps position, inbox alias; 0 console
errors. webui 527/0.

## Follow-up 3: Report tab cleanup (user: how to clean the Report tab)

No cleanup surface existed — the mirror was deliberately append-only (the
archive). Shipped the full path: store.removeReport/clearReports (session
store splices report frames by id); report-persist compactReports (uncapped
rewrite minus removed ids, order kept, corrupt lines kept) + clearReportsFile;
routes DELETE /api/report/<id> (404 unknown) + DELETE /api/report ({removed});
wiring seams remove-first-then-compact; shell: per-article x button (ALL
articles incl. markdown) + pane-level "clear all reports" toolbar that
self-manages with article count. E2E on a WS-snapshot stub (:8893): 3 articles
+ 3 crosses + toolbar -> delete one (right two remain) -> clear all (0, toolbar
gone) -> mirror 0 lines -> restart restored=0; 0 console errors. webui 532/0.

## Follow-up 4: Report tab regenerate — v3.1 architecture IR (archify EXT)

User: clean the Report tab and regenerate current-architecture content via the
archify EXT. Path: (1) the live :8890 process (restarted 22:02, post-#1641)
took DELETE /api/report -> mirror 0 lines, tab clean; (2) authored
ir/pi-agent-ext-webui-v31.architecture.json in the archify package (21
components, 26 connections, 5 views, 5 regions, 3 cards) covering v3.1: 4
hash-addressable tabs, full-bleed shell, two-door report pipeline w/
persistence + cleanup, BTW reverse-ask loop w/ TUI bell, Data telemetry,
Playwright instrument; (3) rendered through the archify deliver path
(archifyRender, vendored archify deliver --json) — the layout validator
enforced clean-flow routing (no edge-through-node, no container-border-run,
label placement); ~15 iterations of via/labelAt routing later: 9/9 checks,
composition pass, sha256 3a94510e6fde; (4) published via POST /api/report
(source archify) -> report-msyr904o-reab; mirror exactly 1 line. Live
verification: Report tab = exactly 1 article (the interactive diagram) with
fullscreen/standalone/x + clear-all, 0 console errors.

## Follow-up 5: wedge incident — webui-side fix (ask watchdog suspension)

Incident (user report 2026-08-18): `[webui] card "Questionnaire"` bell, then
`A web turn was force-released after inactivity (driver: web)`, then 8x goal
wedge alerts, resolved when the user finally answered hours later. Root cause
(webui half): syncPendingState suspended the stale watchdog ONLY for pending
webui_present frames — a pending QUESTIONNAIRE (ask-user bridge) left the
mutex's 10-min stale watchdog armed, so a browser input (web acquires) +
a human deciding >10min = spurious force-release + warning; downstream the
goal heartbeat misread the wait as a stalled session (goal-ext half is a
separate worktree's fix, per the user's split). Fix: pendingAskIds ledger
(rpiv:ask-user:prompt adds + suspend sync; rpiv:ask-user:answered deletes +
re-arm; session_shutdown/dispose clear — no suspension leaks across
sessions); syncPendingState suspends on pending OR pendingAskIds (presentId
stays presentation-only). RED->GREEN TDD: fake-clock test replays the
incident (web acquires, prompt out, +11min fake -> NO force-release; answered
-> re-arm -> +11min -> force-release fires). Test-channel lesson: prompt/
answered ride the pi.events bus (EventEmitter), NOT reg() handlers — emitHost
misses them. webui 533/0.

## Follow-up 6: bell client gate (direction doctrine enforcement)

User doctrine after the wedge incident: TUI->webui projections are OPTIONAL
(notifications, must never confuse the TUI); webui->TUI/core requests are
REQUIRED (mutex coordination stays). Full contact-surface audit found ONE
violator: the card bell rang for every non-silent card even with ZERO browser
clients connected (pure TUI noise — the incident's confusing "[webui]
card Questionnaire" line). Fix: both direction-1 notifies (card bell + the
webui:open "view ready" toast) now gate on server.clientCount > 0; frame
pipelines untouched (cards/views still broadcast + replay for the next
connect). BTW bells stay ungated (direction 2, required). Tests: 0 clients ->
card broadcasts but no bell, open registers+broadcasts but no toast; 1 client
-> open rings the direction-1 PAIR (toast + archify card bell). FakeWebServer
gained a controllable clientCount; the async "webui ready" banner is filtered
from counts (it lands after sync resets). webui 535/0.
