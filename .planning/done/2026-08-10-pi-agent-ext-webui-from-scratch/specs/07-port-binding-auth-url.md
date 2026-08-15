# Spec — webui Port, Binding & URL Discovery (Ticket 07)

> **Scope note.** Ticket 07 was originally framed as an open question (port strategy, auth posture, URL announcement). The decision (user-approved, announce-only) is: **loopback-only binding** (`127.0.0.1`, unchanged) reusing the existing DNS-rebinding-safe `originAllowed` origin guard as the security boundary — with a **simple, OPTIONAL token-based auth** mechanism exposed on `WebServer` (`setTokenAuth(token: string | null)`; `null` ⇒ no check), wired **OFF for v1 loopback** (`null`); a **3-tier port resolution** (`WEBUI_PORT` > `PORT` > `0`); and an **announce-only** URL surfaced to the TUI user at `session_start` via the SDK `ctx.ui` surface — **no auto-open, no `console.log` to the user**. This implements that decision verbatim. It supersedes the ticket file's open Question; cross-reference `tickets/07-port-binding-auth-url.md` and `map.md` at commit time.
>
> **Revision note (final scope).** The merged PR #1245 plan carried token auth (`TokenAuth`, `setTokenAuth`, server-injected shell token). An earlier revision of this spec **dropped** token auth entirely (loopback + origin-guard deemed sufficient). The **final** design is a middle path: a **simple, optional token-based auth** IS implemented on `WebServer` via `setTokenAuth(token: string | null)` — a DI setter mirroring the existing `setHttpRoutes`/`setCommandHandler` pattern. In `WebServer.fetch`, **after the origin guard and before `this.httpRoutes`**, if `this.token !== null` the request token is extracted (`?session=` URL param for GET + WS upgrade; `body.token` for POST) and compared flat `!==` (403 on mismatch); **if `this.token === null`, the check is skipped**. **v1 loopback wires `null`** (loopback binding + the DNS-rebinding-safe `originAllowed` guard is the boundary; the token mechanism is available but OFF). The token channels (`?session=` / `body.token`) exist in the mechanism and are exercised by **unit tests only** — there is **no shell-token injection, no `?session=` threading** in the render shell/routes; `RENDER_SHELL_HTML` stays a plain const. This supersedes the earlier "drop auth entirely" revision.

**Status:** draft (pending user review)
**Effort:** `.planning/2026-08-10-pi-agent-ext-webui-from-scratch/`
**Depends on:** ticket 04 (web transport & protocol) — **MERGED**. Reuses the 04 `WebServer` (`Bun.serve`, loopback `originAllowed` guard, ephemeral port, `serveWithFallback` port-walk, the `setHttpRoutes` DI setter added in ticket 06). ticket 06 (generic render framework) — **MERGED**. Reuses the 06 render shell (the `GET /` document) and render data routes (`/api/*`, `/api/events`).
**Blocks:** nothing formal.

---

## Problem Statement

The webui transport (ticket 04) and render framework (ticket 06) are merged, but two production gaps remain:

1. **No port choice.** The server hardcodes an OS-assigned ephemeral port (`port: 0`). An operator cannot pin it (for firewalls, tooling, or a stable bookmark), and the only discovery mechanism today is `render()` returning a URL in-process — never announced to the person who needs to open it.
2. **No URL discovery.** The resolved URL is **never shown to the TUI user**. `console.log` does not reach the TUI (it is a debug channel the user does not see); there is no `ctx.ui.notify`/`setStatus` call. A user who cannot see the URL cannot open the surface at all.

(The security posture is loopback binding + the DNS-rebinding-safe origin guard (see the Security Model below); a simple **optional** token-auth mechanism is also implemented on `WebServer` but wired **off for v1 loopback** — a cheap layer kept available for future non-loopback use.)

## Solution

Close both gaps with three coordinated decisions, reusing existing seams:

- **Security model.** Loopback-only binding (`127.0.0.1`, unchanged from ticket 04) + the existing DNS-rebinding-safe `originAllowed` guard (checks the request `Origin` against the `Host` header, rejects non-loopback origins, allows absent-Origin for curl/scripts) is the security boundary for v1 loopback. **A simple, optional token-based auth is ALSO implemented** on `WebServer` (`setTokenAuth(token: string | null)`; `null` ⇒ no check) — a cheap extra layer **available but OFF for v1 loopback** (loopback binding + the origin guard already suffice for local single-user use; the token is wired `null`). See the Security Model + D1 below.
- **Port.** A 3-tier resolver: `WEBUI_PORT` env > `PORT` env > `0` (OS-assigned ephemeral). The existing `serveWithFallback` (port..port+50 on `EADDRINUSE`) inherently skips held ports, so `8090` (held by the `embed-mlx-server` LaunchAgent) is avoided without special-casing — there is **no default to 8090**.
- **Announce.** At `session_start`, after `server.start()`, the wiring calls `ctx.ui.notify("webui: <resolved-url>", "info")` and `ctx.ui.setStatus("webui", "<resolved-url>")` — the SDK surfaces that reach the TUI user. This requires undoing the `session_start` handler's downcast of `ctx` to `{ abort() }` (so it can reach `ctx.ui`) and widening the wiring's session-context interface with a mockable `ui` surface. **No auto-open** (the host interface exposes no `exec`, and the wiring never opens a browser); **no `console.log`** (it does not reach the TUI user — debugging only).

## Security Model

The v1 boundary is **already implemented** by ticket 04 and is unchanged here: loopback binding + the DNS-rebinding-safe `originAllowed` guard. On top of that, ticket 07 implements a **simple, optional token-based auth** on `WebServer` (`setTokenAuth`) that is **available but wired OFF for v1 loopback**. Both are documented explicitly so the posture is deliberate, not accidental.

- **Loopback-only binding.** The server binds `127.0.0.1` (ticket 04, unchanged). A non-local process cannot reach the socket at all — the kernel rejects the connection before any application code runs. This is the foundational boundary: the local user owns the machine, so anything that can already reach `127.0.0.1:<port>` can already do everything the user can do.
- **DNS-rebinding-safe `originAllowed` guard (CSRF defense).** A loopback socket alone is NOT a CSRF defense: a browser page the user visits (on a hostile origin) could be made to fetch `http://127.0.0.1:<port>/...` and read the response, or drive the inbound-dispatch seam. Ticket 04's `originAllowed(origin, host)` closes this: it checks the request `Origin` header against the `Host` header (DNS-rebinding-safe — it does not trust the Origin alone), rejects origins that are not loopback (`127.0.0.1`/`localhost`/`[::1]`), and **allows absent-Origin** (so curl/scripts, which send no `Origin`, work). The guard runs in `WebServer.fetch` **and** on the `/ws` upgrade — the single chokepoint. A hostile page is blocked before any route.
- **Optional token auth (`setTokenAuth`, OFF for loopback).** `WebServer` exposes `setTokenAuth(token: string | null): void` — a DI setter mirroring the existing `setHttpRoutes`/`setCommandHandler` pattern. In `WebServer.fetch`, **after the origin guard and before `this.httpRoutes`**, if `this.token !== null` the request token is extracted (`?session=` URL param for GET + WS upgrade; `body.token` for POST) and compared flat `!==` (403 on mismatch); **if `this.token === null`, the check is skipped** and requests pass (just the origin guard). **v1 loopback wires `null`**: loopback binding + the origin guard already close the cross-origin vector, so a per-session token adds friction with zero additional security for a local single-user surface. The mechanism is kept as a cheap optional layer for future non-loopback use (where the origin guard no longer suffices) — wired on by a single `server.setTokenAuth("<token>")` call, no shell injection.
- **What is NOT added (shell-token injection).** No server-injected shell token, no `renderShellHtml(token)`, no `?session=` threading in the render shell or render routes. The render shell is **unchanged** from ticket 06 — `RENDER_SHELL_HTML` stays a plain const. The token channels (`?session=` / `body.token`) exist only inside the `WebServer.fetch` mechanism and are exercised by **unit tests**; no production request carries a token in v1 (the loopback wiring is `null`).

## User Stories

1. As a user, I want the webui URL announced in the TUI at session start, so I can open it without guessing or scraping logs.
2. As a user, I want the URL shown as a persistent status line, so I can find it again later in the session.
3. As a user, I want the browser **not** to auto-open, so opening the URL is my explicit choice (no surprise window).
4. As a user/operator, I want to choose the port via `WEBUI_PORT`/`PORT`, so I can pin it for tooling, firewalls, or a stable bookmark.
5. As a user, I want the default to be an ephemeral OS port, so two concurrent webuis never collide.
6. As a user, I want the server to avoid `8090` (the `embed-mlx-server` port), so both can run together.
7. As a maintainer, I want the render framework's decoupling invariants (ticket 06 D8) to still hold, so adding port/announce does not couple render to chat/mutex.
8. As an extension author, I want the announce to use the SDK `ctx.ui` surface, so it reaches the TUI user — not a debug `console.log` the user never sees.
9. As a future non-loopback deployer, I can set a token via `setTokenAuth` so requests require it — the mechanism is available without changing the render shell or routes.
10. As a loopback user, the token is `null` so there is **no check** — loopback binding + the DNS-rebinding-safe origin guard suffice, and no request needs `?session=`.

## Implementation Decisions

### D1 — Optional token-auth mechanism (`setTokenAuth`, off for loopback)

`WebServer` gains a DI setter mirroring the existing `setHttpRoutes` / `setCommandHandler` pattern, plus a central null-safe check in `fetch`:

```ts
// on WebServer (mirrors setHttpRoutes / setCommandHandler):
private token: string | null = null;
setTokenAuth(token: string | null): void { this.token = token; }
```

In `WebServer.fetch`, **after the `originAllowed` guard and before `this.httpRoutes`**, a single block:

```ts
if (this.token !== null) {
  // ?session= URL param for GET + WS upgrade; body.token (JSON) for POST.
  const presented = extractPresentedToken(req);
  if (presented !== this.token) return new Response("Forbidden", { status: 403 });
}
```

- **`null` ⇒ no check.** When `setTokenAuth` is never called (or called with `null`), `this.token` is `null` and the block is skipped — requests pass with only the origin guard. **v1 loopback wires `null`** (the loopback wiring), so no production request carries a token.
- **Channels.** `?session=` URL param for GET + the WS upgrade; `body.token` (JSON) for POST. Flat `!==` (a cheap local extra-layer, not a remote secret — no timing-safe variant). 403 on mismatch.
- **Placement.** Strictly after the origin guard (the origin guard stays the first chokepoint) and before `this.httpRoutes` (so every additive render route is covered uniformly). The WS upgrade applies the same check after its own origin guard.
- **No shell-token injection.** The channels exist only inside this `fetch` block; the render shell (`RENDER_SHELL_HTML`) and render routes are **unchanged** — no `?session=` threading, no `renderShellHtml(token)`. The channels are exercised by **unit tests only** (non-null token + valid/invalid `?session=` / `body.token`).
- **Interface.** The wiring's `WebuiServer` interface gains `setTokenAuth(token: string | null): void`; the test `FakeWebServer` gains a `setTokenAuth` stub (records the call; default `null`).

### D2 — Port resolution (3-tier)

A pure, injectable resolver chooses the requested port before the (lazy) `WebServer` singleton binds:

```ts
export function resolvePort(env?: Record<string, string | undefined>): number;
//   WEBUI_PORT  >  PORT  >  0 (OS-assigned ephemeral)
//   invalid (non-numeric / out of [1,65535] / empty) falls through to the next tier / 0.
//   Default env source: process.env (injectable for deterministic tests).
```

- **Tier 1 — `WEBUI_PORT`:** honored if a positive integer in range. (webui-specific; wins over the generic `PORT`.)
- **Tier 2 — `PORT`:** honored if `WEBUI_PORT` is absent/invalid. (The conventional env var; shared with other local servers.)
- **Tier 3 — `0`:** OS-assigned ephemeral. The default; two concurrent webuis never collide.
- **Avoiding `8090`:** there is **no default to `8090`**. The existing `serveWithFallback` (walks `port..port+50` on `EADDRINUSE`) inherently skips held ports, so the `embed-mlx-server` LaunchAgent on `8090` is avoided without special-casing. (If an operator *pins* `WEBUI_PORT=8090`, that is their explicit choice and the bind will fail through the walk — surfacing the conflict loudly, exactly as a held-port conflict should.)
- The singleton constructor is changed from a hardcoded `port: 0` to `port: resolvePort()`. `resolvePort()` is called lazily (on first `getServer()`), so test runs with neither env var set still get an ephemeral port (unchanged behavior for the existing singleton-identity test).

### D3 — Announce (`ctx.ui`, session_start, announce-only)

At `session_start`, after `server.start()`, the wiring surfaces the **resolved** URL to the TUI user via the SDK `ctx.ui` surface — the channel that actually reaches the user:

```ts
// inside the session_start handler (after server.start() + bindSession):
const url = server.url;                                  // the resolved loopback URL
sessionCtx.ui.notify(`webui: ${url}`, "info");
sessionCtx.ui.setStatus("webui", url);
```

- **Undo the `ctx` downcast.** The handler currently narrows `ctx` to `{ abort(): void }`, which drops `ctx.ui`. It is widened to a session-context interface that carries a mockable `ui` surface (D4), so the announce can reach it. (`bindSession` still receives the ctx — the widened shape is a structural superset of `{ abort() }`, so the existing bind is unchanged.)
- **Announce the resolved URL.** `server.url` is read **after** `server.start()`, so it reflects the actually-bound port (ephemeral or pinned). The announce fires on every `session_start` (startup / reload / new / resume / fork); `start()` is idempotent and the singleton persists, so the URL is stable across re-announces.
- **No auto-open.** The wiring **never** opens a browser — no `pi.exec("open" / "xdg-open" / "cmd /c start")` (the web-access `openInBrowser` pattern is explicitly **not** reused). The wiring's host interface exposes no `exec`, so it cannot call one; announce-only is the v1 posture.
- **No `console.log`.** `console.log` is a debug channel that does not reach the TUI user; the announce uses `ctx.ui.notify` / `setStatus` exclusively. (Using `ui` is also what makes the announce *testable* — the test asserts the `ui` surface was called, which a `console.log` would fail.)

### D4 — The `ui` surface shape (mirrors the SDK)

The mockable `ui` surface mirrors exactly the two `ExtensionUIContext` members the announce uses (verified against the SDK `.d.ts`):

```ts
export interface WebuiUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}
export interface WebuiSessionCtx {
  abort(): void;        // unchanged — the dispatch closure + bindSession still use it
  ui: WebuiUi;          // new — the announce channel
}
```

The real SDK `ExtensionContext` is a structural superset (`ui: ExtensionUIContext`, `abort()`, …), so the widened `WebuiSessionCtx` is satisfied by the live ctx and by a tiny test stub alike. (`ui` lives on the **session context** — the second arg to the `session_start` handler — **not** on the host; `ExtensionAPI` has no `ui` member. The host interface is unchanged.)

## Testing Decisions

Test external behavior, not internals. (⚠️ **tsconfig gotcha**: the package `tsconfig.json` `include` is `src/**/*.ts` only, so `bun run typecheck` does **not** typecheck `tests/`. Every task that widens an interface the tests implement MUST update the test fixtures in the same task — `MockPi` (the shared helper) and every inline `MockPi` / ctx fake — and the conformance gate is the **full** `bun run typecheck && bun test`, never typecheck alone.)

- **Token-auth mechanism (`WebServer.fetch`, unit):** non-null token + valid `?session=` (GET/WS-URL) / `body.token` (POST) → request passes; non-null token + missing/wrong token → 403; **null token → every request passes (no check)**; the origin guard still runs first (a rejected origin is 403 regardless of token). Covers GET, POST (`body.token`), and the WS upgrade.
- **`resolvePort` (pure):** `WEBUI_PORT` honored; `PORT` honored when `WEBUI_PORT` absent; `WEBUI_PORT` wins when both set; neither → `0`; invalid (non-numeric / negative / out of range / empty) → falls through to `0`. Injectable env (no `process.env` mutation).
- **Announce (wiring):** after `session_start`, `ctx.ui.notify` called **once** with `webui: <resolved-url>` and type `"info"`; `ctx.ui.setStatus` called once with key `"webui"` and the resolved URL. With a real server, the URL is the live `http://127.0.0.1:<port>` (resolved, not the literal `0`). **No auto-open:** the host records `exec` calls and asserts zero (negative control). The shared `MockPi` ctx + every inline ctx fake gain a `ui` stub recording notify/setStatus.
- **Integration (live, through `wireWebui`):** v1 wires `null`, so with **no token** in play: `GET /` serves the shell unchanged, `/api/*` and `/api/events` are reachable via the origin guard (no token gate), `/ws` upgrades via the origin guard — all pass **without `?session=`** (token is `null` ⇒ skipped). The announce fires once at `session_start` with the resolved `server.url`. Port 3-tier resolves `WEBUI_PORT` > `PORT` > `0`. **Decoupling still holds (ticket 06 D8):** the token/port/announce additions do not cause `sendUserMessage`, a `mutex_blocked`/chat frame, or any render→chat coupling.
- **Existing-test impact (expected, in-scope):** `WebServer.fetch` gains the null-safe token block, so the wiring's `WebuiServer` interface widens with `setTokenAuth` — the test `FakeWebServer` gains a `setTokenAuth` stub (records the call; default `null`). The render shell + render routes are unchanged (no token threading), and `RENDER_SHELL_HTML` stays a const. The wiring-live-smoke + render-integration suites gain a `ui` stub on their inline `MockPi.ctx()` (so `session_start` can reach `ctx.ui`).

## Out of Scope (v1)

- **Wiring the token ON for loopback / server-injected shell token.** The optional token mechanism (`setTokenAuth`) is **implemented** but **wired OFF for v1 loopback** (`null`). What stays out of scope: turning it on for loopback (redundant — loopback binding + the origin guard already suffice), and the merged-#1245 plan's server-injected shell token (`renderShellHtml(token)`, `?session=` threading in the shell/routes). The mechanism is available for a future non-loopback deployer to wire on with a single `server.setTokenAuth("<token>")` call.
- **Auto-open browser.** v1 is announce-only; the user opens the URL themselves. (The web-access `openInBrowser` / `pi.exec("open"/"xdg-open"/"cmd /c start")` pattern is deliberately **not** reused. A future ticket may add an opt-in auto-open.)
- **Persistent `appendEntry` transcript row** for the URL (so it survives `/reload` and compaction). v1 announces at each `session_start`; persistence is deferred.
- **`gui-registry`-style multi-webui discovery** (`<git-common-dir>/gui-servers.json`, pid-liveness-pruned, `--all`/`--json`). v1 is single-webui; the registry is deferred.
- **FNV-stable-per-worktree port.** v1 is `WEBUI_PORT` > `PORT` > ephemeral; deterministic-per-worktree hashing is deferred.
- **Remote / multi-user binding.** v1 is loopback-only (`127.0.0.1`); remote binding (and the TLS / stronger-auth it would require) is deferred.
- **Defaulting to `8090`.** Explicitly rejected — `serveWithFallback` already skips held ports; `8090` (embed-mlx-server) is avoided without special-casing.

## Further Notes

- **Reuses ticket 04's `WebServer`** (loopback `originAllowed`, `serveWithFallback`, `setHttpRoutes` DI, `.unref()`) — no new server process, no change to the loopback posture or the origin guard. This ticket touches `web-server.ts` for two things: the optional `setTokenAuth` mechanism + null-safe token block in `fetch` (D1, after the origin guard), and consuming `resolvePort()` for the bind port. The origin guard stays the first chokepoint and is unchanged.
- **Reuses ticket 06's render shell** — the `GET /` document is **unchanged** (`RENDER_SHELL_HTML` stays a plain const). No token is injected; no `?session=` is appended. The shell is still a single inline HTML string (no build step, no committed artifacts).
- **The announce is the user-facing discovery mechanism** — it is the analog of `gui-movie-director`'s `gui:port` (`scripts/gui-port.ts`), but delivered through the extension `ctx.ui` surface (so it reaches the TUI user) rather than printed to stdout. Announce-only (no `--all`/`--json` registry) for v1.
- **`ctx.ui` is on the session context, not the host.** `ExtensionAPI` has no `ui` member; `ExtensionContext` does. The announce widens the **session-context** type the wiring uses (`WebuiSessionCtx`), leaving the host interface (`WebuiHost`) unchanged — `on`, `sendUserMessage`, `events`, `registerTool`. The host gains no new members; in particular it gains **no `exec`** (which is what makes "no auto-open" structurally enforced).
