---
status: active
---

## Destination

A new pi extension `bun-apps/pi-agent-ext-webui` that opens a web service port from within the extension and serves a web frontend which **coexists with the TUI on one live `AgentSession`** (same process). The web frontend can drive the agent like the TUI (prompt / steer / follow-up / abort) and renders results as **structured data** (beyond the TUI's text — diffs, patches, generated artifacts). **Agentic activity is mutually exclusive across the two frontends** — whichever side initiates a model-driving turn holds an exclusive lock; the other is blocked and shows "working…". **Pure app-logic** (direct pipeline / app execution — run.py, image/video generation, local UI ops) runs free on both sides with no lock. It is a general agent frontend, independent of `gui-movie-director`. v1 = minimal MVP (agent parity + basic mutex + generic event forwarding; rich renderers and multi-session deferred).

## Notes

- **Domain**: pi extension architecture + agent SDK. Skills every session should consult: `grilling`, `domain-modeling`, `codebase-design`, `prototype` (in `bun-apps/pi-agent-ext-wayfind/skills/`); `systematic-debugging` if a seam misbehaves.
- **Extension convention (CLAUDE.md)**: one registered entry per package — `extensions/webui.ts` (folder suffix `webui`, no `pi-` prefix). Register in exactly ONE of `manifest.json` `extensions[]` (dynamic/jiti) OR `bun-apps/pi-agent/src/static-extensions.ts` + `manifest.json` `staticExtensions[]` (compiled). Never both. Bun workspace root is `bun-apps/`; `bun install` from there; no top-level `cd` (use `( cd ... && ... )`); English for all written artifacts; `.planning/<effort>/` must be committed + pushed to `origin/main`.

- **Architecture ground truth (verified, v0.84.1)**:
  - The agent loop (`AgentSession`, `@earendil-works/pi-coding-agent`) is decoupled from the TUI — the TUI (`InteractiveMode`) is one of three run modes and owns the live session.
  - Tool results carry structured `details` (`edit`→`{diff,patch}`, `bash`→`{exitCode,fullOutputPath}`, …) + type guards (`isEditToolResult`, …). Rich rendering is a UI task, not a protocol gap.
  - No extension has ever opened a listening port via the pi API. Start `Bun.serve`/`node:http` yourself in `session_start`, `.unref()`, stop on `session_shutdown`.
  - `AgentSession` is **single-driver by design** → the agentic-mutex requirement means we own a coordination lock guarding turn-injection from either frontend.

- **RESOLVED (ticket 01) — drive/observe/abort are a clean, zero-patch path**: from an extension, `pi.sendUserMessage(text, {deliverAs:"steer"|"followUp"})` injects a turn (internally calls `session.prompt()`, works mid-stream); `pi.on("message_*"|"tool_execution_start/update/end"|"tool_result"|"turn_*"|"agent_*"|"session_before_compact"|"session_compact", …)` observes the structured stream ( `tool_result`/`tool_execution_end` carry typed `.details`); `ctx.abort()` aborts. Readable state via `ctx`: `isIdle()`, `signal`, `hasPendingMessages()`, `getContextUsage()`, `model`. NOT exposed without a patch: the `AgentSession` handle itself (full `messages`, `isStreaming`, `isCompacting`) and live `queue_update` deltas (only on `session.subscribe()`, absent from the `ExtensionEvent` union). Precedent for reaching internals exists in `bun-apps/pi-agent/src/patches/`.

- **RESEARCH FINDING (ticket 02) — CBOR server path is NOT production-ready in v0.84.1; lean Path (A)**: the `pi server`/`pi client` CLI is a dead shell (`runServer`/`runClient` unimplemented, `experimentalCli` never wired into the real `pi` binary); the real server is a separate experimental `@earendil-works/pi-server` lib (~3 weeks old, already breaking between 0.84.0→0.84.1 patch releases, "no compatibility guarantees"); there is NO WebSocket/HTTP transport anywhere (unix-only); the headline `RemoteSession` SDK controller is single-driver (exclusive); and the real `pi-tui` does not use `pi-client`, so the standalone TUI has no remote-attach path. At the *protocol* level multi-client co-driving IS supported (shared leases, any attached client can drive, snapshots broadcast to all) — but the plumbing is missing/immature. **Recommended backbone = Path (A): in-process `Bun.serve` + the live `AgentSession` + a self-built agentic mutex**, with an internal command/dispatch seam that could later be re-pointed at `PiServerService`/`PiSessionRuntime` without a full rewrite. Worth stealing from (B) immediately: the snapshot/progress broadcast contract ("authoritative snapshots; progress is transient"). No official or community pi web frontend exists (npm + GitHub search empty).

- **Fact-freshness caveat**: charted while this branch was 6 commits behind `origin/main`. Rebase before resolving tickets that touch pi internals.

## Decisions so far

- [01 — Live session handle & drive API](tickets/01-live-session-handle.md) — RESOLVED: driving/observing/aborting the live in-process session from an extension is a clean, zero-patch path via `sendUserMessage` + `pi.on(...)` + `ctx.abort()`; only `messages` snapshot / `isStreaming` / `queue_update` would need patches.

## Not yet specified

- **Patches-gap scope**: does v1 need the full `messages` snapshot, `isStreaming`, or live `queue_update`? (Each requires a patch to expose the session handle.) Sharpens inside ticket 04 — likely "no" for minimal MVP.
- **Session-tree sync**: when a web-driven turn creates a branch/fork, how does the TUI's session tree reflect it? (after 02/03)
- **Subagent/workflow rendering**: when the web triggers a `subagent`/`workflow` run, where do those render and how is the in-flight registry shared? (after 04/05)
- **Steering/follow-up queue ownership**: does the web frontend get its own pending-message queue, or share the TUI's? (after 03)
- **Multi-session web UI (tabs)**: can the web manage multiple pi sessions? Possibly v1 out-of-scope — undecided. (after 04)

## Out of scope

- Replacing or removing the TUI — destination is co-existence.
- Migrating `gui-movie-director` into webui — independent per scope decision.
- Remote (non-loopback) / multi-user access — v1 is loopback only.
- Adopting the CBOR server path (B) for v1 — too immature in v0.84.1; revisit once `pi-server` stabilizes + ships WS + a real `pi client`.
- A full app-layer rewrite — it is a general agent frontend, not a domain app.
- Mobile / responsive design.
