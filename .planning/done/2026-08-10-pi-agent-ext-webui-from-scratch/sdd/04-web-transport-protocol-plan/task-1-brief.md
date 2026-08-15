### Task 1 — `WebTransport` deep module (pure, no I/O)

**Goal:** Build the protocol's deep module — the pure dispatch decision (inbound `ClientFrame` → `DispatchAction` **descriptor**) and the outbound event→frame mapping (`mapEvent`, delegating to `protocol.toWebFrame`). It returns **descriptors only**: it does NOT call `pi`, does NOT touch `MutexController`, performs NO I/O. This is what makes the entire protocol testable without a live session. Governing spec: `specs/04-web-transport-protocol.md` §3 (`WebTransport` interface, op→pi-call table, depth/deletion test), §4 (frame schema), §6 (appexec bypass; never crash).

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/web-transport.ts`.
- Create: `bun-apps/pi-agent-ext-webui/tests/web-transport.test.ts`.

**TDD test list (RED first — name each):**
- `WebTransport.parseCommand — dispatch matrix`:
  - `prompt -> agentic descriptor (op prompt, text forwarded, source "extension")`
  - `steer -> agentic (op steer)` and `followUp -> agentic (op followUp)`
  - `abort -> agentic descriptor (op abort, no text)`
  - `appexec -> bypass descriptor (kind "appexec", NO source field)` ← the contract that lets Task 3 branch `kind === "agentic"` before gating.
  - `subscribe / unsubscribe -> control descriptor`
- `WebTransport.mapEvent — delegates toWebFrame, .details preserved`: one test per reachable event type (`message_start/update/end`, `tool_execution_start/end` with `toolName`+`details`, `tool_result` with `details`, `turn_start/end`, `agent_settled`, `session_compact`, `session_before_compact`) asserting `type` preserved and `details` forwarded.
- `WebTransport purity`:
  - `parseCommand is deterministic (same input -> same output)`
  - `mapEvent does not mutate the input event`

**Implementation notes:**
- **Consume Task 0's types:** `import { toWebFrame, type ClientFrame, type DispatchAction, type EventLike, type WebFrame } from "./protocol.js"`.
- **`parseCommand` is a pure switch over `frame.type`:** agentic types (`prompt`/`steer`/`followUp`/`abort`) → `{ kind:"agentic", op:<type>, text?, source:"extension" }`; `appexec` → `{ kind:"appexec", op:"appexec" }`; `subscribe`/`unsubscribe` → `{ kind:"control", op:<type> }`. The `source:"extension"` is baked into the agentic descriptor because **all** inbound web agentic commands gate as `"extension"` (spec §1, §6) — Task 3 passes it to `MutexController.handleInput("extension")`.
- **The op→pi-call table is encoded as the descriptor, NOT executed here.** Spec §3 table: `prompt→pi.sendUserMessage(text)`, `steer→pi.sendUserMessage(text,{deliverAs:"steer"})`, `followUp→…{deliverAs:"followUp"}`, `abort→ctx.abort()`. The **resolution** (actual call) is Task 3, after the gate returns `continue`. Keeping it a descriptor is what makes this module pure.
- **`mapEvent` delegates to `toWebFrame`:** `mapEvent(event) { return toWebFrame(event); }`. The deep module's outbound method is a thin delegation; it earns its depth via `parseCommand` + the consolidated type table (spec §3 deletion test).
- **Keep it stateless.** `WebTransport` needs no constructor args, no injected deps. The dispatch + mapping are pure functions; the class is a namespace so callers hold one instance.

**Seams:**
- Consumes: `protocol.js` (Task 0).
- Produces: `WebTransport` → Task 3 (`extensions/webui.ts`) calls `parseCommand` then resolves the descriptor; calls `mapEvent` from every outbound `pi.on` handler.

**Acceptance criteria:**
- `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-transport.test.ts )` green.
- `( cd bun-apps/pi-agent-ext-webui && bun run build )` exits 0.
- `grep -nE "from \"bun\"|from \"@earendil|sendUserMessage|handleInput|\\babort\\(" src/web-transport.ts` returns nothing — no I/O, no pi call, no mutex touch (purity audit).

**Pitfalls:**
- Do NOT call `MutexController.handleInput` inside `parseCommand`. The mutex gate is Task 3's job (the real `input`-event gate, locked by ticket 02). A second gate site here would diverge from the locked decision (spec §4 note).
- Do NOT route `appexec` through any gate — its descriptor must have `kind:"appexec"` and **no** `source` field, so Task 3 can branch on `kind` before touching the controller (spec §6: "Must NOT be routed through handleInput").
- Do NOT execute the op→pi-call here — return the descriptor only. Purity is non-negotiable; it is the Path-B migration guarantee.
- `mapEvent` must not mutate its input (the purity test enforces this).
