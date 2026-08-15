# pi-agent-ext-webui — Architecture v2 (re-design)

> Working design doc for the v2 re-architecture of the webui extension.
> Inputs: full codebase review (findings.md — 35+ catalogued findings incl.
> 2 critical security, 10 major), the three module reviews, the original
> specs (`.planning/done/2026-08-10-pi-agent-ext-webui-from-scratch/specs/`),
> and external TUI+webUI hybrid research (docs/research-tui-agent-webui-hybrids.md).
> Status: IMPLEMENTED (see §7 — every §3/§4/§5 item shipped; the webui package
> suite is green at 364 pass / 0 fail).

## 1. Goal

Make the pi-agent **TUI optionally use the webui** to render agent output and
to interact with the user — a first-class, secure, well-architected co-frontend
— while fixing the v1 review findings (2 critical, 10 major).

## 2. v1 assessment (what stays, what changes)

**Stays (proven, keep):**
- Pure layer split: `protocol.ts` (TypeBox wire schema), `mutex.ts` (AgentMutex
  state machine + watchdog), `render-service.ts` (view registry),
  `btw-channels.ts` (bus seam), `image-presentation.ts`, `port-resolver.ts`.
- `WebServer` singleton (loopback, `.unref()`, lazy start, port-walk,
  additive `setHttpRoutes` seam, `/api/logs` ring, idle-timeout rationale).
- Mutex co-driving model (gate = `input` event; release = `agent_settled`;
  `appexec.respond` HITL return transport; `webui_present` blocking tool).
- Vanilla no-build browser shell philosophy.
- 319-test suite as the contract net.

**Changes (v2):**
1. **Optionality** — the webui becomes opt-out-able (env `WEBUI_DISABLED`,
   `deps.enabled`) and the pi-agent CLI gains `--no-webui` / `--webui-port N`.
2. **Security hardening** — Host-header validation (DNS-rebinding),
   sandboxed markdown rendering (kills the md-mode XSS), symlink-safe
   `/output`, constant-time header token.
3. **Session state + replay** — a client-visible session store (transcript +
   views + mutex state) with a connect-time snapshot frame; the browser shell
   renders the live agent transcript, mutex signals, and gains a main-session
   prompt input + abort button (protocol already supports them).
4. **Protocol correctness** — btw thinking levels widened to 7, declared
   payload fields on known WebFrame members, typed `error` frame, `appexec
   cancel` op, `minLength: 1` on agentic text.
5. **Mutex/present fixes** — pre-aborted-signal hang, per-session reset,
   watchdog suspended while a presentation is pending, mutex feedback visible
   in the browser AND the TUI (ui.notify).
6. **Shell interaction fixes** — WS send queue (no lost HITL answers),
   model-select placeholder bug, boot try/catch, render race, escaping,
   feedback-log cap, mode-label staleness.
7. **Scaffold cleanup** — real lib entry (src/index.ts re-exports),
   package.json description, STUB_PAGE retirement, ticket-era comments.

## 3. Target architecture

```
extensions/webui.ts  (factory; cast pi -> WebuiHost)
   │
   ▼
wireWebui(pi, deps)                     webui-wiring.ts  (composition root)
   │  enabled = deps.enabled ?? !isWebuiDisabled(env)   ← OPTIONALITY GATE
   │  disabled → returns no-op WebuiWiring (no handlers/tools/server)
   │
   ├─ WebServer (singleton, Bun.serve, loopback, .unref')
   │    ├─ originAllowed: Host hostname + Origin port whitelist   [fixed]
   │    ├─ token auth (header, timing-safe)                       [fixed]
   │    ├─ additive routes: btw → render → output
   │    └─ WS: validate → onCommand → dispatch; snapshot on open    [new]
   │
   ├─ SessionStore (NEW: client-visible state)                     [new]
   │    ├─ transcript: appended from message_*/tool_*/turn_* events
   │    ├─ views: delegates to RenderService (existing)
   │    ├─ mutex state: last mutex_blocked / force_release
   │    └─ present: current pending presentation id
   │
   ├─ MutexController (AgentMutex + watchdog)
   │    ├─ reset on session_start                                  [fixed]
   │    ├─ watchdog suspended while pending present                 [fixed]
   │    └─ notifier → broadcaster frames + TUI ui.notify            [fixed]
   │
   ├─ RenderService + render/present event handlers (unchanged core)
   ├─ webui_present tool (pre-aborted-signal fix)                  [fixed]
   ├─ btw store/forwarder/routes (unchanged)
   └─ pi.on registrations (gated by `enabled` + `disposed`)
```

### 3.1 Optionality gate
```ts
// webui-config.ts (NEW, pure)
export interface WebuiConfig { enabled: boolean; port: number }
export function resolveWebuiConfig(env = process.env): WebuiConfig
//   WEBUI_DISABLED ("1"|"true") → enabled:false
//   WEBUI_PORT → port (strict decimal, [1,65535]); else PORT; else 0
```
`wireWebui(pi, deps)`:
- `const enabled = deps.enabled ?? resolveWebuiConfig().enabled;`
- disabled → register NOTHING (no `pi.on`, no `registerTool`, no server
  start), return `{ dispose(){}, registerPending: (id) => Promise.resolve({cancelled:true}) }`.
- `deps.port` overrides env for tests.

pi-agent CLI (`cli.ts` TUI path):
- `--no-webui` → `process.env.WEBUI_DISABLED = "1"` before extension load.
- `--webui-port <n>` → `process.env.WEBUI_PORT = <n>`.
- Flags parsed by a tiny pure helper (cli-argv.ts `webuiFlags(argv)`), so
  cli.ts stays declarative; `-ne` still suppresses the factory wholesale.

### 3.2 Security
- **Host validation** (`web-server.ts`): every request must present a Host
  whose hostname ∈ {127.0.0.1, localhost, [::1]}; a present Origin must still
  equal `http://<loopback-host>:<port>`. No-Origin requests with a
  non-loopback Host → 403 (closes the rebinding-navigation read vector).
- **Sandboxed markdown** (`render-shell.ts`): md-mode views render into the
  SAME `sandbox=""` iframe as html-mode (server-side `marked` output is the
  iframe `srcdoc`). Sandbox blocks scripts/forms/popups; subresource loads
  (same-origin /output images) still work. Controls/toolbar stay DOM-built in
  the parent (never innerHTML of content).
- **/output symlinks** (`output-routes.ts`): `lstat` the resolved file;
  reject symlinks (uniform 404).
- **Token auth** (`web-server.ts`): accept `x-webui-token` header + keep
  `?session=` for compat; `crypto.timingSafeEqual` on equal-length buffers.

### 3.3 Session store + snapshot (the "interact" upgrade)
- `session-store.ts` (NEW, pure-ish): `appendEvent(frame)`, `snapshot()`,
  bounded transcript (e.g. last 500 frames), current views (from registry),
  current mutex driver/present.
- On WS `open`: the server sends one `{type:"snapshot", state}` frame before
  live frames — a browser opening mid-session (or a refresh) sees history.
- The shell renders the transcript (agent message stream) in the main view
  and mutex frames as status lines; a main-session prompt input sends
  `{type:"prompt"}` (protocol already validates it) and an abort button sends
  `{type:"abort"}`.

### 3.4 Protocol (protocol.ts)
- Widen `BtwCommandFrameSchema.level` to the full `BtwThinkingLevel`
  (7 values) — matches `btw-channels.ts` + the shell select.
- Declare payload fields on known WebFrame members (`text?`, `toolName?`,
  `details?`, `reason?`); add `{type:"error", reason}`.
- Add `appexec` `cancel` op → `cancelPending(id)`; shell HITL toolbar gains a
  "Cancel" button (sends the cancel frame instead of dropping the socket).
- `minLength: 1` on `prompt`/`steer`/`followUp` text.

### 3.5 Mutex/present
- `present-tool.ts`: `awaitPendingWithAbort` checks `signal.aborted` first.
- `webui-wiring.ts` session_start: `controller.handleShutdown()` (idempotent
  reset) before rebinding.
- `MutexController`: `setWatchdogSuspended(bool)`; wiring suspends while
  `pending.size > 0` (a legitimate HITL block must never be force-released).
- Notifier: also surfaces block/force-release to the TUI via `ctx.ui.notify`
  (both frontends see the mutex state).

### 3.6 Shell interaction fixes (render-shell.ts)
- WS send queue: outbound frames queue while `readyState !== OPEN`; flush on
  open; HITL `submit()` only disables buttons after a successful send.
- btw-model select: `value === "" → null` (placeholder bug).
- Boot IIFE: try/catch around `refresh()`/`subscribe()`/`btwInit()` + retry.
- renderView: monotonic render token (ignore stale fetches).
- Escape `id`/`role` everywhere (data-id/class), reuse `esc()` for notices.
- Feedback-log: cap at N entries.
- Mode label: set from the pulled `/api/btw` state too.
- `imageMd`: per-segment encodeURIComponent.

### 3.7 Scaffold
- `src/index.ts`: real lib entry re-exporting the public surface
  (`wireWebui`, `WebuiWiring`, `HitlResponse`, config helpers) — package.json
  `main`/`types` keep working.
- package.json description refresh; STUB_PAGE → minimal "not wired" fallback
  page (no stale ticket claims); trim ticket-era comments to "see DESIGN".

## 4. External patterns (from research)

Full report: `docs/research-tui-agent-webui-hybrids.md` (verified live: gptme,
opencode + OpenChamber, aider --browser, Qwen Code Dual Output, OmniTerm,
Agentboard, codex-webui, pi-server/pi-client, ACP, ttyd/GoTTY/WeTTY).

The field has converged on: **the agent owns the session → a local server
exposes it (loopback WebSocket or stdio RPC) → the browser is a subscriber that
renders the structured event stream richly, keeps a raw terminal pane as an
escape hatch, and routes approvals/steering back through the same protocol.**
pi itself ships no webui, but has every backend piece: RPC mode (message_update
deltas, tool_execution_*, extension_ui_request dialogs), an experimental
`server` command with `--auth-token`, and transport-pluggable
`pi-server`/`pi-client`/`pi-protocol` with exclusive/shared session leases +
authoritative snapshots.

Lessons adopted in v2 (with the finding each addresses):
1. **Render from the structured event stream, not a terminal mirror** (gptme,
   OmniTerm, codex-webui, Qwen Code Dual Output) → §3.3 session store + shell
   transcript mirror of message_*/tool_* frames (finding 14).
2. **Authoritative snapshots, not optimistic state** (pi-client) → §3.3
   connect-time `snapshot` frame so a refresh/mid-session open sees history
   (finding 6/10).
3. **Mid-turn control from the web** (OmniTerm, pi RPC abort/steer) → §3.3
   shell prompt input + abort button; §3.4 `appexec cancel` (findings 5, 9).
4. **Explicit in-flight input semantics** (pi RPC streamingBehavior:
   steer vs followUp; Qwen Code warns about browser-injected input) → already
   mapped in the protocol; the shell prompt input uses `prompt` (queued by the
   mutex).
5. **Permission requests are events routed to the surface the user is
   looking at** (ACP; OmniTerm approval cards) → HITL present view auto-focus
   already does this; v2 adds the cancel button.
6. **Loopback bind + opaque token; treat the browser as untrusted; sanitize
   before DOM** (pi server --auth-token; gptme allowed-hosts; pi open-browser
   rationale) → §3.2 host validation + header token + sandboxed md/HTML.
7. **Lease-style co-driving, one agent owns the session** (pi-client
   exclusive/shared leases; ACP) → the v1 agentic mutex IS this model; v2
   keeps it and fixes its edge cases (§3.5).

## 5. Compatibility

- Wire protocol: backward compatible (additive union members only).
- Static extension name/registration unchanged; `-ne` still suppresses.
- Tests: 319 existing must stay green except where a contract intentionally
  changes (thinking-level widening, WebFrame payload fields, error member,
  sandboxed md iframe — the latter is shell-only, no test asserts innerHTML).

## 6. Implementation order
1. webui-config.ts + optionality gate + disabled-wiring tests.
2. Security: host validation, md sandbox, /output symlinks, token header.
3. Protocol: thinking levels, WebFrame payloads, error member, cancel op,
   minLength.
4. Session store + snapshot + transcript/prompt/abort in the shell + send
   queue.
5. Mutex/present: pre-aborted signal, session reset, watchdog suspend, mutex
   feedback to TUI+browser.
6. Shell fixes (model select, boot, race, escaping, log cap, mode label,
   imageMd encoding).
7. Scaffold cleanup (index.ts, description, STUB_PAGE, comments).
8. pi-agent CLI flags (--no-webui / --webui-port) + cli-argv tests.
9. Docs (README optional-usage section) + full gate run.
10. Devops chain: local_ci → PR → merge → verify.

## 7. Implementation notes (shipped)

- **Files added**: `src/webui-config.ts` (optionality gate), `src/session-store.ts`
  (bounded transcript + snapshot), `tests/webui-config.test.ts`,
  `tests/session-store.test.ts`, `tests/cli-argv.test.ts` (pi-agent).
- **Files changed**: webui-wiring (gate, store wiring, watchdog sync, session
  reset, TUI notify, WS-open snapshot seam, cancel dispatch, images→/output
  markdown converter), web-server (Host validation for EVERY request,
  x-webui-token + timing-safe compare, WS-open seam, onCommand guard, port-0
  walk, no-routes fallback relabel, unrefed getter), protocol (7-level thinking
  union, WebFrame payloads + error member, snapshot member, cancel op,
  minLength 1), web-transport (cancel parse), render-shell (sandboxed md,
  transcript mirror, prompt/abort, HITL cancel, send queue, model-select fix,
  boot try/catch, render race token, escaping, log cap, mode label,
  APPEXEC_CANCEL_FRAME), output-routes (realpath containment),
  image-presentation (per-segment encoding), render-event-handler +
  present-event-handler (optional `images` payload → image markdown, F3),
  present-tool (pre-aborted signal), mutex + mutex-controller (watchdog
  suspend), port-resolver (strict decimal), render-routes (URIError 400),
  index.ts (real lib entry), package.json (description), pi-agent cli.ts +
  cli-argv.ts (--no-webui / --webui-port).
- **Behavior changes with tests**: disabled wiring registers nothing; snapshot
  is the FIRST frame a WS client receives; btw thinking levels minimal/xhigh/max
  are no longer dropped; appexec cancel resolves one pending; a suspended
  watchdog never force-releases under a pending presentation; an already-aborted
  signal resolves webui_present immediately; session_start resets a stale mutex;
  TUI users are notified when their input is blocked; no-Origin requests with a
  non-loopback Host are 403; md views render sandboxed; /output serves no
  symlink escapes; empty prompts are rejected; hex/scientific ports rejected.
- **Security posture (v2)**: loopback Host hostname required on EVERY request
  (closes the DNS-rebinding read vector); md + html content render in a
  sandbox="" iframe (no same-origin script exec); /output realpath containment
  (symlink-safe); token via x-webui-token header with constant-time compare.
- **Backward compatibility**: wire protocol is additive-only (union members);
  the static extension name/registration is unchanged; `-ne` still suppresses
  the factory; the webui remains ON by default.
