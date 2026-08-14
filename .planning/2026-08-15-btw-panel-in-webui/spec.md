---
status: draft
effort: 2026-08-15-btw-panel-in-webui
phase: DESIGN (spec) — precedes to-tickets / plan
---

# Spec: btw side panel in the webui (btw-in-webui)

## Problem Statement

The btw extension provides side-conversation tangent threads — a sub-session the user can question, steer, and summarize without polluting the main agent session — but its only surface today is the TUI overlay: 8 slash commands plus an overlay renderer, fully TUI-coupled, with zero outbound events. When the user works through the browser webui (the HITL webui built in `2026-08-14-build-hitl-webui`), the btw capability is simply absent: there is no way to ask a tangent question, no way to see the sub-session's streaming answer or tool status, and no way to inject a tangent conclusion back into the main session — all without touching the browser at all.

## Solution

Bring btw into the browser as a **persistent side panel** next to the main view: always present in the layout, collapsible (state remembered in localStorage), non-blocking. The user asks questions and issues all 8 btw commands from a declarative button bar in the panel; answers stream in via WebSocket as pre-reduced message snapshots; the main view stays fully usable throughout. Development is **webui-led**: the webui extension grows the panel and the transports; pi-agent-ext-btw gains only a minimal event API over the shared SDK event bus (`pi.events`), with **no package dependency from webui → btw** (the existing `webui:render` / `webui:present` channels are the precedent for this seam style). Refreshing the browser or opening a second tab restores the single active thread via a pull-then-subscribe snapshot API. The TUI overlay behavior is unchanged — regression-free.

## User Stories

1. As a webui user, I want a btw side panel always present next to the main view, so that tangent questions are always one click away without blocking my main session.
2. As a webui user, I want to collapse the panel and have the collapse state remembered across refreshes, so that the layout matches my preference without re-configuring each time.
3. As a webui user, I want to type a question in the panel and see the answer stream in as messages, so that I get progressive feedback like a normal chat.
4. As a webui user, I want to see per-message status including running-tool indicators, so that I know when the sub-session is thinking vs. executing a tool.
5. As a webui user, I want a **New** button that replaces the current tangent thread, so that I can start fresh (with the engine's existing dispose-on-mode-change semantics).
6. As a webui user, I want a **Clear** button that resets the current thread, so that I can wipe the conversation while keeping the same thread alive.
7. As a webui user, I want an **Inject** button that pushes the tangent answer into the main session, so that the main agent benefits from the side-conversation's conclusion — with a small confirmation in the panel, and no other main-transcript rendering (accepted v1 gap).
8. As a webui user, I want a **Summarize** button, so that the sub-session condenses the tangent thread.
9. As a webui user, I want a **Model** dropdown fed by the model registry, so that I can run the sub-session on a different model, with the override persisted and the session re-created on apply.
10. As a webui user, I want a **Thinking** toggle, so that I can turn sub-session thinking on/off, persisted like the model override.
11. As a webui user, I want a **mode toggle (Contextual / Tangent)** beside New, so that I can choose whether the sub-session seeds from the main session entries (contextual) or starts empty (tangent), reusing the engine's existing per-mode session reuse/dispose semantics.
12. As a webui user, I want the panel's command surface to be declarative buttons (no slash-command syntax), so that I don't have to learn the TUI command vocabulary.
13. As a webui user, I want a browser refresh to restore the current thread (messages, mode, overrides), so that an accidental refresh loses nothing.
14. As a webui user, I want a second browser tab to show the same single thread, so that multiple tabs are views onto one engine state, not competing sessions.
15. As a webui user, I want to ask/stream (`btw`), so that the core Q&A loop works from the browser exactly as from the TUI.
16. As a btw TUI user, I want my existing overlay + 8 slash commands to behave exactly as before, so that this effort is purely additive.
17. As an agent (main session), I expect **no new btw tools** — only the user starts/asks from the browser — so that the agent cannot spawn tangent threads on its own.
18. As a developer, I want btw's sub-session to keep the `read`/`bash`/`edit`/`write` tools exactly as in TUI btw, so that the sub-session has full parity capability (loopback-only server, token auth stays off as today).

## Grounding (verified in-repo this session)

- **pi-agent-ext-btw**: `BtwEngine` (src/btw/session.ts) owns **one** active sub-session via `createAgentSession` (SessionManager.inMemory, tools `["read","bash","edit","write"]`, resource loader strips extensions/skills/AGENTS.md, system prompt = stripped main prompt + BTW persona). Contextual mode seeds from main session entries; tangent seeds nothing. The thread is persisted as custom entries in the **main** session tree (`btw-thread-entry` / `btw-thread-reset` / `btw-model-override` / `btw-thinking-override`), restored on `session_start`/`session_tree`. `registerBtwFeature` returns the engine instance. Today: **zero outbound events**, fully TUI-coupled; 8 slash commands + overlay; graceful headless degradation but no headless entry point.
- **pi-agent-ext-webui**: `Bun.serve` singleton (loopback, idleTimeout 0). WS `/ws` broadcasts transcript frames verbatim (shell currently send-only — frames unrendered). SSE `/api/events` `view_update` → shell refetches `/api/view/:id`. Routes: `/api/views`, `/api/view/:id`, `/output/*`, `/api/logs`, `/health`. appexec return transport: inbound WS frame `{type:"appexec", extra:{kind:"respond", id, action, tweak?}}` resolves a pending-promise registry, bypasses the mutex. Event channels `webui:render` / `webui:present` via `pi.events` are the intended cross-extension seams. Frontend = single inline `RENDER_SHELL_HTML` constant, vanilla JS, server-rendered markdown (marked), header tabs + main + flex layout — the side panel is a flex-row extension.
- **pi-agent**: `ExtensionAPI` exposes `pi.events` (EventBus emit/on), `pi.registerTool`, `pi.registerCommand`; `ctx.modelRegistry` is available for model listing.

## Implementation Decisions (binding — settled via grilling; do not reopen)

- **D1 Surface**: persistent side panel next to the main view, non-blocking, always present in layout + collapsible (collapse state in localStorage).
- **D2 Trigger**: user-only — the user starts/asks from the browser; the agent has **no** btw tools.
- **D3 Scope**: btw-in-webui only. Residual webui backlog (main transcript rendering, video view, WS reconnect-resume, `/output` ETag/Range, typed `PresentEventPayload`, e2e smoke) stays parked for separate efforts.
- **D4 Architecture**: webui-led + minimal btw API over the SDK shared event bus `pi.events` (the existing `webui:render` / `webui:present` channels are the precedent). **NO package dependency from webui → btw.** btw subscribes to command channels (e.g. `webui:btw_command` style) and emits thread events (e.g. `btw:event` style); exact channel names are an implementation detail for the plan.
- **D5 Wire format**: WebSocket push; btw **pre-reduces** its sub-session `AgentSessionEvent`s into message snapshots (role, text, status incl. running-tool); webui forwards as a **new WS frame type**; the vanilla-JS shell just appends/patches. **No shell-side transcript reducer.**
- **D6 Panel v1 scope**: FULL command parity with the 8 btw commands — ask/stream (`btw`), new (`btw:new`), clear (`btw:clear`), inject (`btw:inject`), summarize (`btw:summarize`), model (`btw:model`), thinking (`btw:thinking`), plus the tangent variant (`btw:tangent`) expressed as a mode toggle.
- **D7 Refresh restore**: new `GET /api/btw` returns the current thread snapshot; panel does **pull-then-subscribe** (refresh / second tab restores). New `GET /api/btw/models` backed by the model registry feeds the Model dropdown.
- **D8 Threads**: single active btw thread, mirroring the engine's single active session; **New** replaces it (with the engine's existing dispose-on-mode-change semantics).
- **D9 Inject**: `btw:inject` pushes the tangent answer into the **main** session; panel shows a small confirmation only. Main transcript remains unrendered in the browser — accepted v1 gap, logged as residual backlog.
- **D10 btw tools**: sub-session keeps tools `read`/`bash`/`edit`/`write` exactly like TUI btw (full parity). Server is loopback-only; token auth stays off as today.
- **D11 Command UI**: declarative button bar in the panel (**New / Clear / Inject / Summarize / Model / Thinking / mode toggle**) following the `webui_present` toolbar pattern; no slash-command syntax required.
- **D12 Model picker**: registry-backed dropdown fed by `/api/btw/models`.
- **D13 Mode**: a contextual/tangent toggle beside **New**; reuses the engine's existing per-mode session reuse/dispose semantics.

### Component sketch (webui-led; names are implementation detail)

1. **btw event API (btw package, minimal)**: emit thread events (message snapshots per D5, thread lifecycle/reset/override changes) on an event-bus channel; subscribe to a command channel carrying the 8 command intents (ask text, new, clear, inject, summarize, model override, thinking override, mode). Keep the engine TUI-coupled path intact; this is an additive seam, no new tool registrations.
2. **webui command ingestion**: `pi.events` handler translates inbound panel commands into btw command-channel events; results/thread updates flow back as webui WS frames (new frame type per D5).
3. **webui HTTP snapshot routes**: `GET /api/btw` (current thread snapshot incl. messages, mode, overrides) and `GET /api/btw/models` (registry-backed model list). Pull-then-subscribe per D7.
4. **Panel UI (RENDER_SHELL_HTML extension)**: flex-row side panel; header with collapse toggle (localStorage); message list (append/patch snapshots); input + button bar (D11); Model dropdown (D12); mode toggle (D13).

## Testing Decisions

- Test external behavior at the existing seams: the event-bus channels (btw ↔ webui), the HTTP snapshot routes, and the WS frame shape. No test may require a real model call.
- **btw package**: event API emission (message snapshots pre-reduced from AgentSessionEvents, incl. running-tool status), command subscription dispatch to the engine, thread persistence/restore unchanged (existing custom-entry tests stay green — TUI regression-free).
- **webui package**: `parseCommand`/dispatch for the new btw command frames; `/api/btw` + `/api/btw/models` route handlers (snapshot shape, registry list); thread-event → WS frame forwarding; shell string/pure-helper tests for panel markup and snapshot append/patch (no DOM env in this package — same prior art as the HITL toolbar tests).
- **Cross-package contract test** (optional, plan decides): a wiring test that loads both extensions against the shared EventBus and drives ask → snapshot → frame, without any package dependency.
- Gates: `bun test` in both packages; webui `check:schema` clean if applicable; **no new dependency between bun-apps packages** is itself an assertion-level concern (no `bun add` cross-links).

## Out of Scope (explicit non-goals)

- Rendering the main agent transcript in the browser (D9 gap → residual backlog).
- Multiple parallel btw threads; btw engine multi-session support.
- Token auth / remote exposure; e2e smoke vs a real agent.
- Other residual webui backlog items (main transcript rendering, video view, WS reconnect-resume, `/output` ETag/Range, typed `PresentEventPayload`).

## Further Notes

- Acceptance anchors (from grilling, refined to house style):
  - From a clean pi-agent start with webui + btw loaded (both static extensions), opening the browser shows the btw side panel; asking a question streams the answer + tool status into the panel while the main view stays usable.
  - All 8 command surfaces work from the button bar; the mode toggle swaps contextual/tangent with correct re-seed behavior; the Model dropdown lists registry models and applying it re-creates the session with the override persisted.
  - Browser refresh restores the thread (pull-then-subscribe); a second tab sees the same single thread.
  - Inject posts to the main session and shows confirmation in the panel.
  - btw's TUI overlay behavior unchanged (regression-free); tests in both packages pass (`bun test`), webui `check:schema` clean if applicable.
  - No new package dependency between bun-apps packages.
- The btw sub-session's tool parity (D10) means the loopback-only / auth-off posture of the webui server is a **load-bearing** constraint — do not widen exposure while the sub-session can run `bash`.
- Next step per the to-spec skill: `to-tickets` to slice this into tracer-bullet tickets, then the plan coordinator's execution substrate.
