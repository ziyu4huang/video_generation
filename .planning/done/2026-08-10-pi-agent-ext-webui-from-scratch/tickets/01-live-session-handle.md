# 01 — Live session handle & drive API

type: research
blocked by: —
status: closed
resolved: 2026-08-10

## Question

From inside a pi extension loaded by the TUI process, what is the exact API surface to **drive the already-live `AgentSession`** (the one `InteractiveMode` created) — i.e. call `prompt` / `steer` / `followUp` / `abort`, and `subscribe` to `AgentSessionEvent`s — and how does it differ from the read-only seams? This is the foundation: every other ticket assumes the web server can drive/observe the live session.

## Resolution

**Verdict: driving the live in-process `AgentSession` from an extension is an INTENDED, clean, first-class path for the three core operations — NO monkey-patch required.** The `AgentSession` owns the extension runner and publishes a curated, fully-typed action+event surface; the runner does NOT hand the session back, so everything reachable is done through bound closures. (pi v0.84.1, `node_modules/@earendil-works/pi-coding-agent/dist/core/{extensions/types.d.ts, agent-session.{d.ts,js}}`.)

**Exact call sheet:**

- **(a) Inject a turn** — `pi.sendUserMessage(text, { deliverAs })`. Bound at `agent-session.js:1855` → internally calls `this.prompt(text, { source:"extension", streamingBehavior: deliverAs })` — the same code path the TUI uses. Idle → sends immediately; mid-stream → `deliverAs:"steer"` interrupts after the current tool batch, `"followUp"` queues for after the run settles. (There is no bare `pi.prompt()`; `pi.sendMessage(customMsg, {deliverAs})` is the custom-typed variant.)
- **(b) Observe the structured stream** — `pi.on(event, handler)`. Available: `message_start/update/end`, `tool_execution_start/update/end` (`end` carries `result` incl. `.details`), `tool_result` (typed `.details`, has a blockable sibling `tool_call`), `turn_start/end`, `agent_start/end/settled`, `input`, `session_before_compact`/`session_compact`.
- **(c) Abort** — `ctx.abort()` (→ `_extensionAbortHandler` or `session.abort()` = abortRetry + agent.abort + waitForIdle). Read `ctx.signal` for the live AbortSignal.
- **Readable state** — `ctx.isIdle()`, `ctx.hasPendingMessages()`, `ctx.getContextUsage()`, `ctx.model`, `ctx.thinkingLevel`.

**NOT exposed (would require a patch — precedent in `bun-apps/pi-agent/src/patches/`):**
- The `AgentSession` handle itself (`ctx.session` / `pi.getSession()` do not exist) → so the full `messages` array, `isStreaming`, `isCompacting`, `retryAttempt` are unreachable.
- **`queue_update`** (steering/follow-up queue deltas) lives only on `session.subscribe()`, NOT in the `ExtensionEvent` union → unreachable from an extension without a patch.

**Implications for the map:** tickets 02/03/04 can proceed against this surface with zero patches for the minimal MVP. Patches enter the picture ONLY if v1 also needs full message snapshot, `isStreaming`, or live `queue_update` (see "Not yet specified" on the map). The cleanest patch shape, if ever needed, mirrors `ext-context-get-system-prompt-options.ts`: wrap `ExtensionRunner.prototype` (or `_bindExtensionCore` at `agent-session.js:1845`) to stash the session onto the bound context.
