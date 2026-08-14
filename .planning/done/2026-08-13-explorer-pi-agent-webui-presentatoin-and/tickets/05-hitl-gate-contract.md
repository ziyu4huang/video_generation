---
type: grilling
status: closed
claimed: explorer-webui
blocked by: 01
---
## Question

Pin the **synthesized blocking HITL gate contract** for the agent-driven webui (the core of the v2 reframe). The agent presents content (e.g. a generated image for review) and BLOCKS its turn; the user's response returns via `appexec` (bypass-mutex) and the agent resumes. Decide:

- **The present/ask tool**: name (`webui_present`? `webui_ask`?), parameters (content/mode/view/title? controls? a correlation id?), and the tool-result return shape (the user's response — approve/regenerate + tweak?).
- **The event payload**: what the tool emits to push the presentation to the browser (content + controls + a correlation id). Reuse `webui:render` or a new `webui:present` channel?
- **The `appexec` response shape**: the inbound frame the browser posts (e.g. `{type:"appexec", extra:{kind:"respond", id, action, tweak?}}`); confirm `parseCommand` must stop dropping `extra` and surface it to the dispatcher.
- **Blocking/abort semantics**: block indefinitely until the user responds? What if the user aborts / the WS disconnects / the session ends / a second presentation arrives while one is pending?
- **Controls**: are Approve/Regenerate fixed for v1 image review, or does each presentation declare its own controls (like ask-user's options)?

**Decided upstream (don't re-litigate)**: blocking HITL gate (like ask-user); `appexec` bypass-mutex is the return seam; drop the passive mirror; loopback/auth unchanged; the #03 toolbar UX + pinned formulations carry (transport shifts to appexec); the `/output/` serving contract survives for media.

Resolve via `grilling` (+ a code-read of ask-user's `execute()` blocking pattern in `pi-agent-ext-core-task/src/ask-user/` + the existing `appexec` plumbing in `protocol.ts`/`web-transport.ts`/`webui-wiring.ts`).

## Resolution

**Closed (2026-08-13)** — the synthesized blocking HITL gate contract is pinned:

1. **Tool `webui_present({content, mode?, view?, title?, controls})`** — the agent calls it to present content for review. `controls` is a DECLARATIVE array (per-presentation, like ask-user options): each `{id, label, takesInput?}`. `execute()` emits the present-event + blocks on a Promise keyed by a generated `id`. Returns structured `{action: <controlId>, tweak?, cancelled?}` (NOT text formulations — those become display/log only).
2. **Event `webui:present`** `{content, mode?, view?, title?, controls, id}` (new channel; `webui:render` retained for any non-blocking render, but the mirror is dropped) → the webui renders content + a button per declared control (controls with `takesInput` reveal a tweak field).
3. **Response transport**: browser posts `{type:"appexec", extra:{kind:"respond", id, action, tweak?}}` (bypass-mutex). `parseCommand` stops dropping `extra` and surfaces it; the dispatcher's `appexec` case resolves the pending Promise by `id`. This is the return path the `appexec` seam was reserved for.
4. **Blocking/abort semantics**: blocks until the user responds OR aborts. Abort = WS disconnect / session end / explicit cancel → resolves `{cancelled:true}`. No timeout (loopback HITL). One pending presentation at a time (a second while one is pending is rejected/errored for v1).
5. **Controls**: declarative per-presentation. The #03 Approve/Regenerate become the DEFAULT/example control set the agent emits for image review (`[{id:"approve",label:"Approve"},{id:"regenerate",label:"Regenerate…",takesInput:true}]`), not hardcoded in the shell.

**Decided upstream (honored)**: blocking HITL gate (like ask-user); appexec bypass-mutex return; drop the mirror; loopback/auth unchanged; #03 toolbar UX + formulations carry (formulations → display text; transport → appexec); /output serving survives.

**Build (post-spec)**: appexec resolver + pending-Promise registry; the `webui_present` tool + `webui:present` event; browser declarative-controls toolbar (evolve the #03 prototype's `attachFeedbackToolbars` + shift `sendSteer` → `sendAppexecResponse`); image presentation via /output URL; drop the tool_result mirror + "tools" view + repurpose `webui_render`.
