---
status: complete
effort: 2026-08-14-build-hitl-webui
phase: DESIGN (spec) — precedes SDD plan + EXECUTE
---

# Spec: agent-driven HITL webui (interactive-webui-v2 build)

## Destination

Build the **agent-driven, blocking HITL interactive webui** per the filed wayfinder map (`.planning/done/2026-08-13-explorer-pi-agent-webui-presentatoin-and/`) and the #05 contract. The agent presents content via a `webui_present` tool and **blocks its turn**; the user responds via **declarative controls**; the response returns via the **`appexec` bypass-mutex seam**; the agent resumes with a structured result. Passive tool-result mirroring is **dropped**. Loopback-only, auth-off.

## Context (from the map + grounding)

- **ask-user model**: a tool's `execute()` blocks on a Promise; the answer returns as the tool result (see `bun-apps/pi-agent-ext-core-task/src/ask-user/ask-user-question.ts`). The webui can't use `ctx.ui.custom()` (browser ≠ TUI overlay) so it **synthesizes** the gate.
- **The synthesized gate**: `webui_present.execute()` emits a `webui:present` event and blocks on a Promise keyed by an `id`; the browser posts `{type:"appexec", extra:{kind:"respond", id, action, tweak?}}`; the `appexec` dispatch resolves the Promise; `execute()` returns `{action, tweak?, cancelled?}`.
- **appexec today**: plumbed end-to-end (`protocol.ts` schema, `web-transport.ts` `parseCommand`, `webui-wiring.ts` `dispatch`) but `dispatch`'s `appexec` case is a NO-OP and `parseCommand` **drops `extra`**. Building the return transport = surface `extra` + a pending-Promise registry + resolve.
- **#03 prototype** (`bun-apps/pi-agent-ext-webui/src/render-shell.ts`, shipped in #1290): WS client + `attachFeedbackToolbars` (per-image `[Approve][Regenerate…]`) + `sendSteer` + on-screen log. Starting point for the browser toolbar — **evolve** `sendSteer` → `sendAppexecResponse`; render **declarative** controls.
- **#02 serving contract** (shipped in #1274, SURVIVES the mirror drop): port `handleGalleryImage` via `setHttpRoutes`, serve `MLX_OUTPUT_DIR` at `/output/{name}`, MIME allowlist (png/jpg/webp/gif + mp4), `nosniff`, path-traversal containment, loopback `originAllowed`-guarded.

## The HITL gate contract (#05, pinned — do not re-litigate)

- **Tool `webui_present({content, mode?, view?, title?, controls})`**: `controls` = declarative array, each `{id, label, takesInput?}`. `execute()` emits the event + blocks on a Promise (keyed by a generated `id`). Returns structured `{action: <controlId>, tweak?, cancelled?}` (NOT text formulations).
- **Event `webui:present`** `{content, mode?, view?, title?, controls, id}` → browser renders content + a button per control (controls with `takesInput` reveal a tweak field).
- **Response transport**: browser posts `{type:"appexec", extra:{kind:"respond", id, action, tweak?}}` (bypass-mutex). `parseCommand` surfaces `extra`; `dispatch`'s `appexec` case resolves the pending Promise by `id`.
- **Blocking/abort**: blocks until response OR abort (WS disconnect / session end / explicit cancel → `{cancelled:true}`). No timeout (loopback HITL). **One pending presentation at a time** (a second while one is pending → error for v1).
- **Controls**: declarative per-presentation. The #03 Approve/Regenerate become the DEFAULT example set for image review (`[{id:"approve",label:"Approve"},{id:"regenerate",label:"Regenerate…",takesInput:true}]`).

## Components

### 1. appexec resolver + pending-Promise registry (return transport)
- `web-transport.ts` `parseCommand`: stop dropping `extra`; surface a typed `{kind:"appexec", op:"respond", id, action, tweak?}` (validate the respond shape; ignore unknown ops).
- `webui-wiring.ts` `dispatch` appexec case: a `Map<id, {resolve, reject}>` registry; on `respond` → resolve the pending Promise with `{action, tweak?}`; unknown id → ignore.
- **Abort**: on `session_shutdown` + WS close, reject/resolve all pending as `{cancelled:true}` (so a blocked `execute()` returns cleanly).

### 2. `webui_present` tool (the blocking gate)
- New tool (e.g. `present-tool.ts`): params `{content, mode?, view?, title?, controls}` (TypeBox schema; `controls` required, each `{id, label, takesInput?}`).
- `execute(_callId, params, signal, _onUpdate, ctx)`: generate `id`; `pi.events.emit("webui:present", {…params, id})`; register a Promise in the registry keyed by `id`; `await` it (abortable via `signal`); on resolve → return `{content:[{type:"text", text: humanReadable}], details:{action, tweak?, cancelled?}}`; on abort → `{cancelled:true}`.
- Guard: one pending at a time (second `webui_present` while one pending → tool error for v1).

### 3. `webui:present` event (content push)
- New event channel `webui:present` (handler in `present-event-handler.ts`): validate `{content, controls, id, mode?, view?, title?}`; push to the browser (see open decision A) + store the pending presentation so a reconnecting browser can re-fetch.

### 4. Browser declarative-controls toolbar (evolve #03 prototype)
- `render-shell.ts`: on receiving a present (`{id, content, controls}`), render the content + a toolbar with a button per control (`takesInput` → reveal a tweak input).
- On control click (+ tweak): `ws.send(JSON.stringify({type:"appexec", extra:{kind:"respond", id, action: controlId, tweak?}}))`.
- Evolve `attachFeedbackToolbars`/`sendSteer` → `renderPresent`/`sendAppexecResponse`. Keep the on-screen log. One present shown at a time.

### 5. Image presentation via /output
- The agent presents a generated image as `content: "![image](/output/0/{basename})"` (md → `<img>` via marked, served by the #02 `/output` route). Image review = `webui_present({content: md, controls: [approve, regenerate]})`.
- The agent (or a thin helper) constructs the presentation from flux2/ltx `details.output`/`outputs[].path` → `/output/0/{basename}`.

### 6. Drop the mirror
- Remove `tool-mirror.ts` (`createToolMirror`) + its wiring (`reg("tool_result", …)`).
- Remove the "tools" view (the mirror's accumulation target).
- `webui_render` tool: **remove** for v1 (all presentation is HITL via `webui_present`); the `webui:render` event handler can stay dormant (retained for a future non-blocking render) or be removed (see open decision B).

## Decisions (resolved)

- **A. Present delivery**: **Reuse the render-view mechanism** — a present is a special view carrying `{controls, id}` (alongside `content/mode/view/title`), delivered via the existing SSE `/api/events` and fetchable via `/api/view/:id`. No new endpoint/channel. The browser renders the view's content + its declared controls.
- **B. `webui_render` tool + `webui:render` event**: **Remove the `webui_render` tool** (all presentation is HITL via `webui_present`); **keep the `webui:render` event handler dormant** (forward-compatible for a future non-blocking render, ~free).
- **C. Pending-presentation storage**: **In-memory `Map<id, …>`** keyed by id, cleared on resolve/abort. Sufficient for loopback v1; no persistence.

## Tests (webui quirk: `tsconfig` includes only `src/**` → run FULL `bun test`, not typecheck; update fixtures in-task)

- appexec resolver: `parseCommand` surfaces `extra`/respond shape; `dispatch` resolves pending Promises by id; unknown id ignored; abort (session_shutdown/ws-close) → all pending `{cancelled:true}`.
- `webui_present` tool: `execute()` blocks; on `appexec respond` → returns `{action, tweak?}`; on abort → `{cancelled:true}`; one-pending guard (second → error).
- `webui:present` event: handler validates + pushes (per decision A).
- Browser toolbar (string + pure-helper tests; no DOM env in this package): `renderPresent` markup; `sendAppexecResponse` frame shape; declarative-controls rendering.
- Image presentation: content md construction from `details.output`.
- Drop mirror: `tool_result` no longer mirrors; "tools" view gone; `webui_render` removed (per decision B).

## Phasing (SDD — high level; detailed plan next)

1. **appexec resolver + registry** (return transport) — unblocks the gate.
2. **`webui_present` tool + `webui:present` event** (the gate).
3. **Browser declarative-controls toolbar** (evolve the #03 prototype).
4. **Image presentation via /output**.
5. **Drop the mirror + `webui_render`**.
Each phase: spec slice → test → implement (TDD); one PR per phase.

## Out of scope (deferred fog)

Video `<video>` player view; annotation/markup; structured-feedback shape beyond `{action,tweak}`; conversation branching/fork; resumable-SSE `lastEventId`.

## References

- Filed map: `.planning/done/2026-08-13-explorer-pi-agent-webui-presentatoin-and/` (destination + #01–#05).
- #05 contract (the gate spec) — `tickets/05-hitl-gate-contract.md` in the filed effort.
- Grounding: ask-user (`bun-apps/pi-agent-ext-core-task/src/ask-user/`); appexec (`protocol.ts`/`web-transport.ts`/`webui-wiring.ts`); #03 prototype (`render-shell.ts`); #02 serving (`render-routes.ts` `setHttpRoutes` seam).
