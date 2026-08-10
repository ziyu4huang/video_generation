# 02 — Architecture backbone — in-process+mutex vs CBOR leases

type: grilling
blocked by: 01
status: closed
resolved: 2026-08-10

## Question

What is the architecture backbone for a web frontend co-driving one live session with the TUI: (A) in-process `Bun.serve` + the live `AgentSession` + a self-built mutex, or (B) the experimental CBOR server + pi-client shared-lease model?

## Resolution

**DECISION: Path A — in-process `Bun.serve` + the live `AgentSession` + a self-built agentic mutex, with a thin dispatch seam shaped for future Path-B migration.** Confirmed by the human; the evidence was one-sided and the destination (in-process co-driving) rules out B for v1.

**The seam (the resolution's deliverable):**
- **Server**: one module-level `Bun.serve` (HTTP + native WS, loopback `127.0.0.1`, `.unref()`-able). Started lazily on the FIRST `session_start` (the runtime/ctx isn't ready before then; `assertActive()` throws); kept across session switches via a module-level singleton — the extension *factory* re-runs per session, but the *module* is cached, so singleton state persists. `session_shutdown` drops only the session ref; the server stays (clients aren't dropped on every `/new`/`/resume`/`/fork`). `before_agent_start` is wrong (per-turn).
- **Session binding**: on each `session_start`, re-point the server's `pi`/`ctx` to the live session; WS commands call `pi.sendUserMessage({deliverAs})` / `ctx.abort()` against the current session.
- **The mutex gate** (delegated to ticket 03): the `input` extension event is the single chokepoint — `pi.on("input", …)`, synchronous `driver` flag set before the first `await`, `{action:"handled"}` to block the losing side, `event.source` (`interactive`/`extension`/`rpc`) for attribution. Zero patch.
- **Outbound**: `pi.on("message_*"|"tool_execution_*"|"tool_result"|"turn_*"|"agent_*"|"session_*compact", …)` → WS frames, `tool_result`/`tool_execution_end` `.details` preserved.
- **Future-migration seam**: inbound-dispatch (commands → session actions) and outbound-mapping (events → frames) are a thin interface that could later be re-pointed at `PiServerService`/`PiSessionRuntime` (Path B) without rewriting the web client. Steal B's contract now: "authoritative snapshots; progress is transient."

**Evidence (citations in map.md Notes):**
- `InteractiveMode.run()` is a cooperative `while/await` loop (interactive-mode.js:807); `Bun.serve` on a TCP socket coexists, never touches stdin/tty, `.unref()`-able, services HTTP+WS during awaits. (research A)
- The `input` event (types.d.ts:619-643; agent-session.js:814-826) fires for all submissions before the `isStreaming` guard; `{action:"handled"}` blocks; `source` distinguishes origin. (research A)
- `web-access` proves an extension CAN host a listening server in-process (`node:http` on `listen(0,"127.0.0.1")` + token + browser-open, inside the agent process) — the only pi extension that does. (research B/C)
- `gui-movie-director` is the proven `Bun.serve` (HTTP+WS, loopback, port-fallback, origin guard, Bun.build) template in this repo. (research C)
- Path B is not production-ready in v0.84.1: `pi server`/`pi client` CLI is a dead shell (`runServer`/`runClient` unimplemented, never wired); real server is separate experimental `@earendil-works/pi-server` (~3 weeks old, already breaking 0.84.0→0.84.1); no WS transport; `RemoteSession` SDK is single-driver; real `pi-tui` can't attach. (prior research 02)

**Unblocks:** 03 (mutex state machine around the `input` gate), 04 (transport/protocol over Bun.serve WS). **Reuse:** gui-movie-director (04/06/07), web-access (07), btw (04 inbound pattern).
