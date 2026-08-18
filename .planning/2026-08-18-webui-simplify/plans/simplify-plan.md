# webui-simplify Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: superpowers:subagent-driven-development
> or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Restore minimal AI chat in the webui Inbox and shrink the extension
(fewer tabs, one live transport, one JSONL mirror) per the user-approved spec
at ../spec.md.

**Architecture:** Four independently-mergeable PRs on feat/webui-simplify,
each TDD red->green. The mutex input-event gate, WS snapshot transport, and
persistence seams are reused, never duplicated.

**Tech Stack:** Bun + TypeScript, bun:test, WebSocket + SSE routes in
Bun.serve; pi extension host (structural slices).

## Global Constraints
- Written artifacts English; mutex doctrine untouched (input event IS the
  gate; block feedback broadcast-only).
- Gates: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`
  green before each PR; push `--no-verify` + PR-body GATE BYPASS NOTE.
- No backtick/`${` inside inserted shell JS (render-shell template-literal
  rule); `\u2715` for the ✕ glyph.

---

### Task 1 (PR1): Chat restore — agentic dispatch + Inbox composer

**Files:**
- Modify: bun-apps/pi-agent-ext-webui/src/webui-wiring.ts (case "agentic" ~:816; WebuiSessionCtx ~:85; sendMessage seam ~:614)
- Modify: bun-apps/pi-agent-ext-webui/src/render-shell.ts (inbox pane markup + composer JS)
- Test: bun-apps/pi-agent-ext-webui/tests/chat-restore.test.ts (new)

**Interfaces:**
- Produces: `sendMessage(text: string, opts?: { deliverAs?: "steer"|"followUp" }): void` seam; `WebuiSessionCtx.abort?: () => void`; shell ids `webui-input` / `webui-send` / `webui-abort`.

- [ ] RED: tests/chat-restore.test.ts — wireWebui over MockPi+FakeWebServer; after session_start, drive `server.commandHandler` with `{type:"prompt",text:"hi"}` -> deps.sendMessage recorded `["hi"]` with no opts; `{type:"steer"}` -> opts.deliverAs "steer"; `{type:"followUp"}` -> "followUp"; `{type:"abort"}` -> ctx.abortCalls 1; unknown text still ignored. Shell literals: RENDER_SHELL_HTML contains `id="webui-input"`, `id="webui-send"`, `id="webui-abort"`, `type: 'prompt'`, and isSendEnter-guarded Enter.
- [ ] Run: `bun test tests/chat-restore.test.ts` -> FAIL (dispatch breaks; literals absent).
- [ ] GREEN wiring: WebuiSessionCtx gains `abort?(): void`; sendMessage seam passes opts; case "agentic": abort op -> `sessionCtx.abort?.()`; else `sendMessage(text, { deliverAs: op === "steer" ? "steer" : op === "followUp" ? "followUp" : undefined })`. Update the RETIRED comment.
- [ ] GREEN shell: composer div inside the inbox pane section; doSend uses the shell raw-send helper with `{type:'prompt', text}`; Enter guarded by isSendEnter; click #webui-abort sends `{type:'abort'}`; on successful send append the text client-side to the feed (styled `.me`).
- [ ] Run full suite + typecheck -> green (expect bell/pilot suites unaffected).
- [ ] Commit: `feat(webui): restore minimal AI chat — Inbox composer + revived agentic dispatch`; open PR, GATE BYPASS NOTE, gh ship.

### Task 2 (PR2): Tab consolidation — More pane

**Files:**
- Modify: render-shell.ts (nav + panes + hash router), tests/pane-hash.test.ts
**Interfaces:** Produces: `#more` route; `resolvePaneAlias(hash)` mapping `#data`/`#btw` -> `#more`.
- [ ] RED: pane-hash tests — paneHashOf('more') === '#more'; handlePaneHash('#data')/('#btw') activate more-pane (aliases); nav has exactly four tabs.
- [ ] GREEN: move btw pane + data pane sections into `<section id="more-pane">` (subheaded "BTW" / "Data"); nav = Inbox/Cards/Report/More; BTW badge on More label; aliases via one resolver.
- [ ] Full suite + typecheck; commit `refactor(webui): fold Data+BTW into a secondary More tab`; PR + ship.

### Task 3 (PR3): SSE -> WS merge

**Files:**
- Modify: render-routes.ts (cut /api/events SSE + heartbeat), render-shell.ts (standalone reader: EventSource -> WS client), tests (render-routes/web-transport)
**Interfaces:** Consumes: existing WS snapshot + view frames. Produces: reader-side `subscribeViews(onChange)` over WS.
- [ ] RED: /api/events absent (fetch 404) test updated; reader literal test — no `EventSource` in RENDER_SHELL_HTML; WS-client onmessage handles view frames.
- [ ] GREEN: reader opens the same WS endpoint, treats snapshot + view_opened as change signal, refetches /api/view/:id; delete SSE route + heartbeat + EventSource block.
- [ ] Full suite + typecheck; live spot-check standalone /raw page on a scratch port; commit `refactor(webui): one live transport — standalone reader moves SSE->WS`; PR + ship.

### Task 4 (PR4): JSONL mirror helper

**Files:**
- Create: src/jsonl-mirror.ts; Modify: report-persist.ts, btw-store.ts; Test: tests/jsonl-mirror.test.ts
**Interfaces:** Produces: `persistPath(dir, port, name): string`, `appendLine(path, obj)`, `loadJsonl<T>(path, cap, revive): T[]`, `compactJsonl(path, keepLine)`, `clearFile(path)`.
- [ ] RED: jsonl-mirror unit tests (append/load cap/compact-keep-corrupt/clear over a tmp file).
- [ ] GREEN: extract shared code; both stores become adapters; BOTH existing suites pass unmodified.
- [ ] Full suite + typecheck; commit `refactor(webui): one JSONL mirror pattern — shared jsonl-mirror helper`; PR + ship.
