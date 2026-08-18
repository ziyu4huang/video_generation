# pi-agent-ext-webui — Architecture v3 (pure HITL companion)

> Successor to architecture-v2.md. v2 described the transcript-mirror webui;
> v3 (2026-08-17/18) REMOVED that premise. Status: IMPLEMENTED — webui suite
> 516 pass / 0 fail; every item below ships with tests and is verified by the
> power-tool `webui` audit (7 design invariants, real headless Chrome).
> Decision log: `.planning/done/2026-08-16-webui-v3-simplify/` (D1–D4).

## 1. Premise shift (what v3 removed)

The TUI owns the conversation and tool logs; the webui owns INTERACTION.

- **Frame diet at the source** (t02): the wiring subscribes ONLY the HITL
  frame families — `card`, `card_done`, `report`, `ask_user`,
  `ask_user_done`, `session_info`, `error`, `mutex_blocked`,
  `mutex_force_release`, `snapshot`, `appexec`, `view_opened`. Log families
  (`message_*`, `tool_execution_*`, `tool_result`, `turn_*`,
  `agent_settled`, `session_*compact`) never reach the wire, store, or shell.
- **Transcript machinery deleted** (t03): txEl/txAppend/txLine, message/tool
  renderers, tx CSS — gone (−68 lines). The bus-snoop SKIP set is decoupled
  from the diet (clearing the subscribe list would re-project logs as cards).

## 2. The shell — three tabs, dynamic app-shell

- **Tabs**: Inbox (`#cards-pane` id kept; ask cards + event cards; boot
  default), Report, Data (viewer iframes). `#card-<id>` deep links activate
  the owning tab; the TUI bell is centralized at the store-wrapped broadcast.
- **Dynamic layout** (#1577): `body` is a 100dvh flex column, overflow
  hidden; panes `flex: 1 + min-height: 0` — they fill EXACTLY the available
  height at any window size (internal scroll only; verified across
  1920x1080 / 1440x900 / 390x844 with zero page overscroll). The idle present
  surface (`#content`) hides via `:empty`.

## 3. Reports — two doors, one archive

- **Producers** (identical frames by construction — shared
  `src/report-frame.ts`): the `webui_report` tool (in-process, zero sockets,
  core/always-on) and `POST /api/report` (external). Contract: title 1–200,
  exactly one body mode, 16MB cap (#1573).
- **Rendering** (#1576/#1583): html frames render in a sized (70vh)
  `sandbox="allow-scripts allow-downloads"` iframe. Two escape hatches exist
  because a sandboxed iframe has an OPAQUE origin — the parent cannot measure
  the inner document, and WITHOUT allow-downloads Chromium silently blocks
  exports (fullscreen does NOT change sandbox flags): a per-article
  **fullscreen button**, and **`GET /api/report/<id>/raw`** — the frame's
  html as a TOP-LEVEL document with the /files CSP (`sandbox allow-scripts
  allow-downloads` + nosniff; native edge scrolling, working export menus;
  unknown/markdown-only ids 404).
- **Persistence** (#1590): report frames mirror to
  `~/.pi/webui/reports/reports-<port>.jsonl` (best-effort; WEBUI_REPORT_DIR
  override); the newest 25 reload at boot via store-append (no broadcast —
  no bell, no live push). The Report tab is the archive surface: report
  frames are exempt from the bounded card-eviction cap.

## 4. Clean-boot contract (#1592)

Zero console errors on a clean boot: an EMPTY main view slot answers 204
(not 404 — a state, not a missing resource), and the shell head carries
`<link rel="icon" href="data:,">` so no favicon request ever fires. The
audit invariant `zero-console-errors` is green on clean boots by design.

## 5. Verification — the `webui` audit (power-tool)

Seven invariants, real headless system Chrome, screenshots per tab,
dogfood publish (the audit POSTs its own report into the audited webui's
Report tab; the persistence mirror accumulates audit history):
`panes-exclusive` · `ask-cards-located` · `viewer-cards-located` ·
`report-articles-located` · `report-iframe-sized` (>=320x300, measured with
the pane SHOWN — 0x0 counts as unmeasured; the #1576 300x150 default passed
all earlier invariants) · `zero-page-errors` · `zero-console-errors`.
Playbook: `skills/webui-audit/SKILL.md` + power-tool README.

## 6. v2 sections that still hold

Security posture (loopback + Host/Origin guard, /files containment, token
mechanism available/OFF), the agentic mutex + HITL answer bridge
(first-answer-wins, queued offline), SSE heartbeat, idle timeouts — see
architecture-v2.md; unchanged in v3 except where superseded above.
