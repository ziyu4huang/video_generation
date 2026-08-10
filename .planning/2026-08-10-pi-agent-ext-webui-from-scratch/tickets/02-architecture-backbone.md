# 02 — Architecture backbone — in-process+mutex vs CBOR leases

type: grilling
blocked by: 01
status: open

## Question

What is the **architecture backbone** for a web frontend co-driving one live session with the TUI: **(A)** in-process `Bun.serve` calling the live `AgentSession` directly + a **self-built agentic mutex**, or **(B)** the experimental **CBOR `server` + `pi-client` shared-lease** model? Decide after weighing control vs maturity vs the WebSocket-transport gap.

## Context (research attached — ticket is near-resolved toward A)

- Requirement: web + TUI **share one live session**; agentic turns are **mutually exclusive**; app-logic runs free. `AgentSession` is single-driver by design → either path needs a coordination story.
- **Path (A)** — in-process: the extension's `Bun.serve` calls `pi.sendUserMessage()`/`ctx.abort()` and observes via `pi.on(...)` (all clean per ticket 01). Both the TUI and the web live in ONE Bun process sharing ONE `AgentSession`; we add our own lock guarding turn-injection. Full control; we re-implement mutex/lease semantics ourselves. Browser WS is trivially ours.
- **Path (B)** — CBOR: at the *protocol* level the server supports exactly this — multiple shared leases attach to one `sessionId`, **any attached client can drive** (no single-writer lock; `requireAttached` only checks attachment), and snapshots broadcast to all (`@earendil-works/pi-server` `LiveSessionManager`, `sessions.js`). BUT in v0.84.1 it is NOT production-ready:
  - The `pi server` / `pi client` CLI is a **dead shell** — `runServer`/`runClient`/`runPi` are referenced but unimplemented; `experimentalCli` is never imported by the real `pi` binary (`dist/main.js`).
  - The real server is the separate experimental lib `@earendil-works/pi-server` ("experimental … no compatibility guarantees", ~3 weeks old, **already breaking 0.84.0→0.84.1**: `SessionSummary`→`SessionMetadata`; `toProtocolToolResultMessage` now needs the original `ToolCall`).
  - **No WebSocket/HTTP transport anywhere** — `pi-protocol`/`pi-client`/`pi-server` ship unix-only. A browser needs a WS `ByteTransportFactory` (client, ~40 LOC) + a WS `PiServerListener` (server, ~50–80 LOC + upgrade auth) — small + testable (`@earendil-works/pi-server/testing` ships a conformance suite) but you own it.
  - The headline `RemoteSession` SDK controller is **single-driver** (exclusive acquisition) — co-driving needs raw `PiClient` + `attachSession()` shared leases.
  - The real `pi-tui` does **not** use `pi-client` → the standalone TUI has no remote-attach path; making the TUI co-drive via CBOR means patching/forking it.
- **No official or community pi web frontend exists** (npm + GitHub search empty).

## What resolving looks like

A grilling decision (A vs B vs hybrid) stating: the deployment shape (same-process extension server vs separate hosted process), the mutex/lease story, and — if A — an internal command/dispatch seam designed so a future migration to `PiServerService`/`PiSessionRuntime` is mechanical (steal B's snapshot/progress broadcast contract: "authoritative snapshots; progress is transient"). The evidence is strongly one-sided toward **A**; this ticket exists to get the human's explicit confirmation and to lock the seam design.
