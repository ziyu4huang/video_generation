---
type: prototype
status: open
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
