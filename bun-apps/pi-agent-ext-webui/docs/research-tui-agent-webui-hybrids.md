# Research: TUI-agent + webUI hybrids

*Research date: 2026 (web sources checked live; versions/claims verified against repos where noted).*

This report surveys open-source projects that run an AI coding agent primarily in a **terminal (TUI)** and **optionally render into / accept input from a browser**, plus the adjacent patterns (terminal-in-browser, session mirroring, HITL-in-browser) and what **pi** itself offers today.

---

## Directly relevant projects

| Project | URL | One-liner | How TUI + webUI are mixed | License |
|---|---|---|---|---|
| **gptme** | https://github.com/gptme/gptme · https://gptme.org/docs/server.html | Terminal agent (Python) that ships a real browser UI over the same sessions | `gptme-server` runs a local HTTP server (`http://localhost:5700`); a modern React web UI ([gptme-webui](https://github.com/gptme/gptme-webui), hosted at [chat.gptme.org](https://chat.gptme.org/)) connects to it and chats / runs tools exactly like the CLI. Server and web UI share one origin by default; CORS-controlled for the dev origin (`GPTME_SERVER_ALLOWED_HOSTS`). Also speaks [ACP](https://gptme.org/docs/acp.html) so third-party clients can drive it. | MIT |
| **opencode** | https://github.com/anomalyco/opencode (was sst/opencode) · https://opencode.ai/docs | Terminal-native AI coding agent (Rust) | TUI is primary. Officially: desktop app + IDE extension + `/share` for sharing sessions; supports [ACP](https://agentclientprotocol.com/). The web story is mostly **community-built**: [OpenChamber](https://github.com/openchamber/openchamber) (desktop + browser + PWA over opencode; "start in TUI, continue on tablet, same session"), [oc-web](https://github.com/shuv1337/oc-web), [portal](https://github.com/hosenur/portal), [OpenCode-TUI-Tunnel](https://github.com/igovet/OpenCode-TUI-Tunnel) (run the TUI itself in a browser tab). | MIT (core) |
| **OpenChamber** (opencode-chamber) | https://github.com/openchamber/openchamber | Rich desktop/web interface for OpenCode | Explicit TUI↔web **session co-driving**: same session continues across TUI → browser → phone (PWA). Diffs, permission cards, integrated terminal, plan/build modes. | MIT |
| **pi** (earendil-works) | https://github.com/earendil-works/pi · npm `@earendil-works/pi-coding-agent` | Self-extensible TypeScript coding-agent CLI + TUI | No shipped webui (see dedicated section below), but has the exact plumbing: `--mode rpc` (JSONL agent events over stdio), an experimental `server` command (`--listen`, `--auth-token`), and new `@earendil-works/pi-server` / `pi-client` / `pi-protocol` packages for multi-client session serving. Community wrappers (OmniTerm, Agentboard) drive pi from a browser via tmux. | MIT |
| **crush** (charmbracelet) | https://github.com/charmbracelet/crush | Charm's TUI coding agent | TUI-only today, but architecturally notable: built as a **local client/server** app (`internal/server` with an event bus) that the TUI attaches to — a natural seam for a future web client. No webui shipped. | MIT (NOASSERTION on API, MIT intent) |
| **aider** | https://github.com/Aider-AI/aider · https://aider.chat/docs/usage/browser.html | Terminal pair-programmer (Python) | Ships an **experimental browser UI**: `aider --browser` launches a browser version that edits the same local git repo; docs also cover running aider fully in the browser. | Apache-2.0 |
| **Qwen Code** | https://github.com/QwenLM/qwen-code · https://qwenlm.github.io/qwen-code-docs/en/users/features/dual-output/ | Alibaba's terminal coding agent | **Dual Output** is the closest match to "render rich output to a web side-panel while TUI stays primary": a sidecar mode streams structured events out of the TUI via **FIFOs (named pipes)**; a web/desktop ChatUI hosts the TUI inside a PTY, renders a parallel markdown conversation view, and lets the user type in **either surface** (TUI or web), keeping both in sync. Also has a "Daemon Web UI Adapter" draft. | MIT |
| **OmniTerm** | https://github.com/GDWhisper/OmniTerm | One browser tab to watch/drive many CLI agents (Claude Code, Codex, Gemini, OpenCode, Qwen Code, Kiro, …) via tmux | tmux-backed: each agent runs in a tmux window; browser shows per-agent status cards, a chat view driven by **ACP** (permission approve/deny in-browser, mid-session model/thinking switches), built-in xterm.js terminal + file browser, tab-flash + sound when the agent needs you. | FSL-1.1-MIT |
| **Agentboard** | https://github.com/gbasin/agentboard | Lightweight Web GUI for tmux optimized for agent TUIs (Claude, Codex, Pi) | tmux + WebSocket + xterm.js + React. Run server on desktop, connect from phone/laptop (Tailscale/LAN); auto-matches sessions to tmux windows, parses agent logs, mobile-first. **Explicitly supports Pi sessions.** | MIT |
| **codex-webui** | https://github.com/LimLLL/codex-webui | Web frontend for OpenAI Codex CLI | Backend (NestJS) talks to `codex app-server` over **stdio JSON-RPC** and pushes real-time events to a React frontend via Socket.IO; in-page approval cards, threads, Monaco editor, shared xterm.js terminal. | AGPL-3.0 |
| **Claude Code** (Anthropic) | https://code.claude.com/docs/en/web-quickstart · /docs/en/remote-control | Anthropic's agent, now multi-surface | CLI/Desktop/IDE are local; **web** runs cloud sessions at [claude.ai/code](https://claude.ai/code) (cloned VM, watch+steer, PR review). Closest to "TUI + browser co-drive" is **Remote Control**: `claude remote-control` lets you drive a *running local CLI/VS Code session* from claude.ai/code or mobile. Headless Agent SDK for custom UIs. | Proprietary (research preview) |
| **Continue** | https://github.com/continuedev/continue · https://docs.continue.dev/cli/quickstart | IDE-extension agent with a `cn` CLI | The **same agent core powers the VS Code/JetBrains extensions and the `cn` terminal CLI** ("the same agent that powers the Continue IDE extensions, running in your terminal"), sharing config/assistants/MCP. Not a browser UI, but the "one engine, many surfaces" pattern. | Apache-2.0 |
| **goose** (Block / AAIF) | https://github.com/block/goose | Rust agent with desktop app + CLI + API | Native **desktop app** (macOS/Linux/Windows) and full CLI over the same engine; 2.0 beta announced a new architecture/TUI with **ACP** client support. | Apache-2.0 |
| **OpenAI Codex CLI** | https://github.com/openai/codex | Terminal agent (Rust) | TUI plus an official **`codex app-server`** (crates `codex-rs/app-server-daemon` + `app-server-client`) exposing JSON-RPC over stdio/websocket — the seam every community webui (codex-webui, AionUi, aiui) builds on. Cloud "Codex Web" lives at chatgpt.com/codex. | Apache-2.0 |
| **AionUi** | https://github.com/BIGPHOR/AionUi | Local open-source desktop "cowork" app for Gemini CLI, Claude Code, Codex, OpenCode, Qwen Code, Goose CLI, … | Desktop GUI (and mobile companion) that supervises many CLI agents, one card per agent, permission/approval UI, resumes sessions — same "watch and step in" idea as OmniTerm but as an app. | open source |
| **aiui** | https://github.com/shaneholloman/aiui | Free local GUI app for Gemini CLI, Claude Code, Codex, Qwen Code, … | Local GUI + WebUI over the CLI agents with multi-agent view. | open source |

*Also seen in searches (less TUI-first, included for completeness):* **agno** (https://github.com/agno-agi/agno) — Python multi-agent framework with a web Playground; **CrewAI** — framework with CrewAI Studio/UI; **Cody** (Sourcegraph) — IDE-first, no TUI↔web hybrid; these are "framework with a web console" rather than "TUI that mirrors to browser".

---

## Adjacent patterns

### Terminal-in-browser (generic, not agent-specific)
- [**ttyd**](https://github.com/tsl0922/ttyd) — share a real terminal over the web (WebSocket + xterm.js). The workhorse behind many agent-in-browser setups.
- [**GoTTY**](https://github.com/yudai/gotty) — share your terminal as a web application.
- [**WeTTY**](https://github.com/butlerx/wetty) — Web + TTY over SSH.
- [**wssh**](https://github.com/progrium/wssh) — websocket shell (SSH to web).
- [**shellinabox**](https://github.com/shellinabox/shellinabox) — AJAX terminal emulator.
- [**tmate**](https://github.com/tmate-io/tmate) — instant terminal *sharing* (tmux fork with remote pairing), the classic "mirror my terminal for someone else's browser" tool.
- **tmux + web**: OmniTerm and Agentboard above are the agent-optimized take; the pattern is "tmux as the durable session store, a small server parses windows/logs, browser renders xterm.js and forwards keystrokes."

### Session mirroring / passive viewers
- [**Claude-Code-Web-GUI**](https://github.com/binggg/Claude-Code-Web-GUI) — browse/share Claude Code session logs entirely in the browser, no server (JSONL parsed client-side).
- [**agent-explorer**](https://github.com/unixzii/agent-explorer) — browser-based explorer for agent session logs.
- [**claude-code-log**](https://github.com/daaain/claude-code-log) — convert Claude transcript JSONL to readable HTML/Markdown.
- [**ai-relay**](https://pypi.org/project/ai-relay/) — WebSocket relay bridging agent CLIs (Claude Code, Codex, Gemini CLI, Snowflake Cortex) to *any* web interface, streaming.

### HITL-in-browser (permission/approval as the web surface)
- [**ACP — Agent Client Protocol**](https://agentclientprotocol.com/) — the emerging standard: an agent (server) exposes session/event/permission primitives; any client (TUI **or** browser) can chat, approve/deny tool calls, and steer. Adopted by opencode, gptme, OmniTerm, goose 2.0, and more — this is the cleanest "TUI primary, browser secondary" contract to build against.
- **pi's RPC extension-UI requests** (below) are the same idea in-house: `select/confirm/input/editor` dialogs streamed as events any UI can render.

---

## What pi itself offers today

Verified against https://github.com/earendil-works/pi (`main`) and the npm registry (all packages at **0.84.2**, checked live):

- **No shipped webui.** The official monorepo has no web/browser UI package, and `@earendil-works/*` npm scope contains no webui (packages: `pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`, `pi-server`, `pi-client`, `pi-protocol`, `pi-telemetry`). No `--web` flag in the CLI.
- **RPC mode** (`pi --mode rpc`, documented in `packages/coding-agent/docs/rpc.md`): headless JSONL protocol over stdin/stdout — commands (`prompt`, `steer`, …) with request ids, and a rich event stream: `agent_start`, `message_update` (text deltas), `tool_execution_start/end`, `agent_end`, plus **`extension_ui_request`** dialogs (`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`). Explicitly designed so custom UIs can be built on it — see `examples/rpc-extension-ui.ts` (a TUI built purely on the RPC stream; a web UI could consume the identical protocol). Includes `streamingBehavior: steer|followUp` for queuing input during an in-flight turn.
- **Experimental `server` command** (`packages/coding-agent/src/cli/experimental/commands/server.ts`): `pi server` with `--listen <transport>` and `--auth-token` / `--auth-token-file` — i.e. the loopback-server primitive is already stubbed in the CLI.
- **New session-server architecture** (`@earendil-works/pi-server`, `pi-client`, `pi-protocol`, all marked experimental): `PiServer` composes pluggable transport listeners; today it ships a **Unix-socket listener** (CBOR framing, socket-filesystem permission auth), and the README explicitly describes the WebSocket-listener pattern ("validate credentials during the HTTP upgrade"). `PiClient` is transport-neutral ("connect using WebSocket, Unix socket, or another ordered byte transport") with **exclusive/shared session leases** so multiple frontends can attach to one session safely, authoritative snapshot subscriptions, and no optimistic state mutation. This is a TUI→web-ready session server; only the web frontend itself is missing.
- **Browser helper only for auth**: `src/utils/open-browser.ts` opens provider auth URLs in the platform browser — the one place pi currently touches a browser.
- **Community/forks**: OmniTerm and Agentboard both explicitly support driving pi from a browser (via tmux); an HF Space ([AlexWortega](https://huggingface.co/spaces/AlexWortega/qwen35-4b-clawd-rift-coding-agent)) bundles `pi-coding-agent` + llama-server + chat UI. Note: npm/GitHub results like `@xianzhon/pi-webui`, `@ashwin-pc/pi-web`, `enjoyZhou/pi`, `terrylica/pi-mono` are **community forks/renames** of pi that advertise "TUI & web UI libraries" — not official earendil-works releases; verify before trusting.

---

## Design lessons for "TUI agent optionally renders into and interacts via a loopback webui"

Concrete lessons from the projects above, mapped to transport, auth, co-driving, rendering, and input routing.

**Transport — pick one, but design for pluggability**
- **Stdio JSONL RPC subprocess** is the cheapest seam: the webui spawns `pi --mode rpc` (or `codex app-server`) and consumes JSON events (pi rpc.md; codex-webui). Zero network surface, works headless, easy to test.
- **Loopback WebSocket server** is the mainstream choice for "open a tab while the TUI keeps running": ttyd/GoTTY/WeTTY prove the terminal case; Agentboard/OmniTerm prove the agent case (xterm.js over WebSocket). pi-server's listener interface is explicitly designed so a WebSocket listener can slot in next to the Unix-socket one.
- **FIFO sidecar** (Qwen Code Dual Output) lets the TUI *keep owning the PTY* while structured events are duplicated to a named pipe for a parallel web view — lowest-risk for "TUI is primary, web is a mirror," and it avoids two writers corrupting one terminal.
- **Standardize HITL on ACP** if you want interop: permission requests, steering, and session metadata as a protocol (opencode, gptme, OmniTerm, goose 2.0 all speak it).

**Auth**
- Default to **loopback-only bind + opaque token**: pi's `server` command already takes `--auth-token`/`--auth-token-file`; gptme-server relies on CORS/origin allow-lists (`GPTME_SERVER_ALLOWED_HOSTS`) and same-origin serving. OmniTerm does first-run password set in the browser.
- For Unix sockets, **filesystem permissions are the auth** (pi-server unix listener) — simpler and safer than tokens for a local loopback UI.
- Treat the browser as **untrusted**: never pass user-influenced strings through shell (`pi`'s open-browser.ts deliberately avoids `cmd /c start` because of metacharacter injection); sanitize tool output before rendering in the DOM.

**Session co-driving (TUI and web, same session)**
- **One agent process owns the session; every frontend is a subscriber.** pi-client's **exclusive/shared leases** are the right model: a mutation/lifecycle coordinator takes exclusive, passive viewers take shared; commands rejected while a conflicting lease exists.
- **Authoritative snapshots, not optimistic state**: pi-client explicitly does not mutate snapshot state from progress events — the web panel should render server truth and reconcile.
- **Define in-flight input semantics**: when the agent is streaming, a queued prompt needs explicit policy — `steer` (deliver after current turn's tool calls, before next LLM call) vs `followUp` (after agent stops) — pi RPC `streamingBehavior`. Qwen Code warns that browser-injected input must be validated to avoid corrupting the TUI's own output.
- **Permission requests are events, not modal blocking**: route `select/confirm/input/editor` (pi) or ACP permission requests to whichever surface the user is currently looking at; allow approve/deny from either (OmniTerm, codex-webui approval cards).

**Rendering**
- Render from the **structured event stream** (message deltas, tool calls, results, thinking) into markdown/components — that is what makes the web view better than a terminal mirror (OmniTerm chat view, OpenChamber diff views, codex-webui Monaco/Git-diff).
- Keep a **raw xterm.js terminal pane as the escape hatch** for anything unstructured (Agentboard, OmniTerm, codex-webui, Qwen Code dual-mode all do this).
- For sharing/offline review, **render the JSONL session log statically** in the browser with no server at all (Claude-Code-Web-GUI, agent-explorer).

**Input routing**
- Both surfaces may send prompts; make the **ordering explicit** (queue + steer/followUp) and let one surface own interactive dialogs at a time (pi's rpc-extension-ui swaps the prompt line for the dialog and returns focus after).
- Support **mid-turn control from the web**: abort, steer, model/thinking-level switch (OmniTerm; pi RPC `abort` in the example client).
- Keep **state continuity across surfaces**: "start in TUI, continue on phone, back to terminal — same session" is OpenChamber's headline feature and requires the session to live in the agent (or tmux), not in the renderer.

### Bottom line
The field has converged on a formula: **agent owns the session; a local server exposes it (WebSocket or stdio RPC); the browser is a subscriber that renders structured events richly, keeps an xterm.js terminal as fallback, and routes approvals/steering back through the same protocol (ideally ACP).** pi already has every piece except the web frontend: RPC mode, an experimental `server` command, and a transport-pluggable `pi-server`/`pi-client` pair with lease-based co-driving — a loopback webui for pi is a frontend + one WebSocket listener away, not an architecture change.
