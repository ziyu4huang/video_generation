# webui-btw-branch — BTW tab + Data telemetry demo (+ full-bleed scrollbar fix)

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
