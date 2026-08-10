# 07 — Port, binding, auth & URL discovery

type: task
blocked by: —
status: open

## Question

What are the **port, binding, auth, and URL-discovery** choices — loopback-only? auth token? fixed vs auto port (mind `embed-mlx-server` on 8090)? and how does the user learn the URL (print to TUI at `session_start`, à la `gui:port`)?

## Context

- A web server on a port is a security surface. v1 is loopback-only (out-of-scope: remote/multi-user).
- Port collision awareness: `embed-mlx-server` holds 8090 via a LaunchAgent. Prefer auto-port or a non-conflicting default.
- URL discovery: the TUI can print the URL at `session_start` (mirror `bun-apps/gui-movie-director`'s `gui:port` pattern).
- Auth: loopback + no-auth is dev-convenient; a bearer token is cheap insurance — pick one. This ticket is unblocked and can run in parallel.

## What resolving looks like

A task/grilling decision: binding (loopback), port strategy, auth posture, and the URL-announcement mechanism — concrete enough to implement.
