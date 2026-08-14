---
type: prototype
status: closed
claimed: explorer-webui
blocked by: 01
---
## Question

Pin the **shell-hosted feedback toolbar UX** for v1: build a thin mockup in `render-shell.ts` (vanilla inline shell w/ scripts) and react to it.

- **Toolbar**: per-result `[Approve] [Regenerate…]` controls in the SHELL (not inside the sandboxed media view — controls need scripts). Regenerate opens a tweak-text field.
- **Action mapping**: Approve → `ws.send({type:"steer"|"followUp", text:"<approve formulation>"})`; Regenerate → `ws.send({type:"steer", text:"regenerate <target> with: <tweak>"})` via the EXISTING `sendUserMessage` channel. Decide the exact steer formulations.
- **Targeting**: how the toolbar knows WHICH result it acts on (active view? latest tool_result? a result-id?).
- **Mockup scope**: thin end-to-end stub (placeholder image + working toolbar buttons that send/log the steer) to react to the UX before building the real renderer (#02).

**Decided upstream**: feedback via steer-text (not appexec structured); shell-hosted controls + sandboxed media. This ticket pins the UX + message formulations.

Resolve via `prototype` (react to mockup) + `grilling` (pin message formulations).

## Resolution

**Closed (2026-08-13)**: the prototype (render-shell per-image `[Approve][Regenerate…]` toolbar + WS steer-send + on-screen steer log; 226 tests green) validated the UX — per-image controls in the shell DOM, media inline. **Formulations PINNED** (keep defaults): Approve → steer `Approved: image <basename> looks good, no changes needed.`; Regenerate → steer `Regenerate image <basename> with: <tweak>` / `Regenerate image <basename>.`. **Transport RE-SCOPED** by the HITL reframe: the fire-and-forget steer-send shifts to an `appexec` HITL response (the toolbar posts the response; the agent's blocked turn resumes). The toolbar-injection code + formulations carry into the HITL build (#05 → spec). Targeting (this ticket's open question) is MOOT — the agent knows what it presented.
