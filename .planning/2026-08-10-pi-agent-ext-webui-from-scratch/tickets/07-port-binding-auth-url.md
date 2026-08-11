# 07 — Port, binding, auth & URL discovery

type: task
blocked by: —
status: closed
resolved: 2026-08-11

> **Spec'd + planned (final scope).** Resolved as: loopback-only (origin-guard boundary) + simple optional token auth (`setTokenAuth(token: string | null)`; `null` ⇒ no check; loopback passes `null`) + 3-tier port (`WEBUI_PORT` > `PORT` > `0`, avoid 8090) + announce via `ctx.ui` notify+setStatus (no auto-open). See ../specs/07-port-binding-auth-url.md + ../plans/07-port-binding-auth-url-plan.md.

## Question

What are the port, binding, auth, and URL-discovery choices — loopback-only? auth token? fixed vs auto port (mind `embed-mlx-server` on 8090)? and how does the user learn the URL (print to TUI at `session_start`, à la `gui:port`)?

## Context (reuse is now concrete)

- **Binding**: loopback `127.0.0.1` only (out-of-scope: remote/multi-user).
- **Origin guard**: lift `bun-apps/gui-movie-director/lib/origin.ts` `originAllowed(origin, host)` verbatim — DNS-rebinding-safe loopback allowlist (`127.0.0.1`/`localhost`/`[::1]`) keyed off the **Host** header, applied to both HTTP and the WS upgrade. Absent Origin (curl/scripts) allowed.
- **Auth**: `randomUUID()` session token, passed `?session=` (GET) / `body.token` (POST) / WS upgrade — every handler `validateToken()` → 403 (from web-access). Cheap CSRF defense on top of loopback.
- **Port**: avoid `8090` (`embed-mlx-server` LaunchAgent). Mirror gui-movie-director: explicit `--port` > `PORT` env > auto-port; `serveWithFallback` walks port..port+50 on `EADDRINUSE`; FNV-hash-per-worktree for stable per-worktree ports. Consider a registry file (`lib/gui-registry.ts`: `<git-common-dir>/gui-servers.json`, pid-liveness-pruned) if multiple webuis could run.
- **URL discovery**: print the URL at `session_start` (mirror `gui-movie-director`'s `gui:port` — `scripts/gui-port.ts` is pure/testable; default prints own URL, `--all` lists live servers, `--json` machine-readable).
- **Browser open**: `pi.exec("open"/"xdg-open"/"cmd /c start")` cross-OS (from web-access `openInBrowser` / obsidian `openObsidianUri` / archify `openLoopbackUrl` — three near-identical copies; webui could be the first to factor a shared util). Optional: glimpseui embedded window (web-access path).
- Align with 04 (transport) and 06 (delivery). Unblocked — can run in parallel.

## What resolving looks like

A task decision: binding (loopback), port strategy (auto + fallback, avoid 8090), auth posture (token), and the URL-announcement mechanism — concrete enough to implement, reusing gui-movie-director's origin/registry/port + web-access's token/browser-open.
