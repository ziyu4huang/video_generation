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
