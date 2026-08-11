# Spec — webui Port, Binding, Auth & URL Discovery (Ticket 07)

> **Scope note.** Ticket 07 was originally framed as an open question (port strategy, auth posture, URL announcement). The decision (user-approved, announce-only) is: 3-tier port resolution, unchanged loopback binding, a `randomUUID` session token validated **centrally** in `WebServer.fetch`, a render shell that bootstraps itself with a **server-injected** token, and an **announce-only** URL surfaced to the TUI user at `session_start` via the SDK `ctx.ui` surface — **no auto-open, no `console.log` to the user**. This implements that decision verbatim. It supersedes the ticket file's open Question; cross-reference `tickets/07-port-binding-auth-url.md` and `map.md` at commit time.

**Status:** draft (pending user review)
**Effort:** `.planning/2026-08-10-pi-agent-ext-webui-from-scratch/`
**Depends on:** ticket 04 (web transport & protocol) — **MERGED**. Reuses the 04 `WebServer` (`Bun.serve`, loopback `originAllowed` guard, ephemeral port, `serveWithFallback` port-walk, the `setHttpRoutes` DI setter added in ticket 06). ticket 06 (generic render framework) — **MERGED**. Reuses the 06 render shell (the `GET /` document) and render data routes (`/api/*`, `/api/events`); threads the auth token into the shell.
**Blocks:** nothing formal.

---

## Problem Statement

The webui transport (ticket 04) and render framework (ticket 06) are merged, but three production gaps remain:

1. **No auth.** Every loopback route is open. Any local page or script that can reach `127.0.0.1:<port>` can read rendered views, open the WS, and — via the inbound dispatch seam — drive the agent session (prompt/steer/abort). Loopback binding is necessary but not sufficient: a browser page visited by the user, or a stray local process, can issue same-origin-looking requests. There is no CSRF defense at all.
2. **No port choice.** The server hardcodes an OS-assigned ephemeral port (`port: 0`). An operator cannot pin it (for firewalls, tooling, or a stable bookmark), and the only discovery mechanism today is `render()` returning a URL in-process — never announced to the person who needs to open it.
3. **No URL discovery.** The resolved URL is **never shown to the TUI user**. `console.log` does not reach the TUI (it is a debug channel the user does not see); there is no `ctx.ui.notify`/`setStatus` call. A user who cannot see the URL cannot open the surface at all.

## Solution

Close all three gaps with four coordinated decisions, reusing existing seams and the sibling `pi-agent-ext-web-access` token pattern:

- **Auth (D1–D3).** A `randomUUID()` session token, created at wiring time. Validation runs **centrally** in `WebServer.fetch` — **after** the existing loopback `originAllowed` guard, **before** the additive `httpRoutes` — so it covers the render data routes (`/api/*`), the SSE channel (`/api/events`), the `/ws` upgrade, and `/health`. Token channels mirror web-access: `?session=` in the URL for GET and the WS upgrade, `body.token` for POST, flat `!==` compare, **403 on mismatch**. The ONE exempt route is the shell bootstrap (`GET /`): it is the document that delivers the server-injected token to the browser, so it must load from the announced base URL (which carries no token).
- **Server-injected shell token (D4).** The render shell is generated with the token baked into its JS (`const TOKEN="…"`), so the client appends `?session=TOKEN` to every `/api/*` fetch and the `/ws` upgrade. The user never types or sees the token.
- **Port (D5).** A 3-tier resolver: `WEBUI_PORT` env > `PORT` env > `0` (OS-assigned ephemeral). The existing `serveWithFallback` (port..port+50 on `EADDRINUSE`) inherently skips held ports, so `8090` (held by the `embed-mlx-server` LaunchAgent) is avoided without special-casing — there is **no default to 8090**.
- **Announce (D6–D7).** At `session_start`, after `server.start()`, the wiring calls `ctx.ui.notify("webui: <resolved-url>", "info")` and `ctx.ui.setStatus("webui", "<resolved-url>")` — the SDK surfaces that reach the TUI user. This requires undoing the `session_start` handler's downcast of `ctx` to `{ abort() }` (so it can reach `ctx.ui`) and widening the wiring's session-context interface with a mockable `ui` surface. **No auto-open** (the host interface exposes no `exec`, and the wiring never opens a browser); **no `console.log`** (it does not reach the TUI user — debugging only).

## User Stories

1. As a user, I want the webui URL announced in the TUI at session start, so I can open it without guessing or scraping logs.
2. As a user, I want the URL shown as a persistent status line, so I can find it again later in the session.
3. As a user, I want the browser **not** to auto-open, so opening the URL is my explicit choice (no surprise window).
4. As a user, I want the surface protected by a session token, so a stray loopback page or script cannot read my rendered views or drive my agent session.
5. As a user, I want the token invisible to me (I just open the announced base URL), so the auth is frictionless.
6. As a user, I want the render shell to authenticate its own subsequent calls, so once I open the URL everything "just works" without me pasting a token.
7. As a user/operator, I want to choose the port via `WEBUI_PORT`/`PORT`, so I can pin it for tooling, firewalls, or a stable bookmark.
8. As a user, I want the default to be an ephemeral OS port, so two concurrent webuis never collide.
9. As a user, I want the server to avoid `8090` (the `embed-mlx-server` port), so both can run together.
10. As a maintainer, I want auth enforced in ONE place (`WebServer.fetch`, before any route), so no route — present or future — can accidentally bypass it.
11. As a maintainer, I want the render framework's decoupling invariants (ticket 06 D8) to still hold, so adding auth/port/announce does not couple render to chat/mutex.
12. As an extension author, I want the announce to use the SDK `ctx.ui` surface, so it reaches the TUI user — not a debug `console.log` the user never sees.

## Implementation Decisions

### D1 — Token auth (`TokenAuth`, pure)

A pure factory that mints a session token and validates inbound requests against it. Mirrors `pi-agent-ext-web-access`'s `validateToken` (`?session=` / `body.token` / 403), lifted into a reusable, testable unit.

```ts
// createTokenAuth() → TokenAuth
//   token: a randomUUID() session token (node:crypto, repo norm — same as web-access).
//   validateRequest(req): async; true iff the request carries the token.
export interface TokenAuth {
  readonly token: string;
  validateRequest(req: Request): Promise<boolean>;
}
export function createTokenAuth(): TokenAuth;
```

**Channels (flat `!==` compare, 403 on any mismatch — no Bearer-header scheme; loopback + token is the posture):**
- **GET / WS upgrade:** `?session=<token>` in the request URL. (`new URL(req.url).searchParams.get("session") === token`.) The WS upgrade is a GET, so the same `?session=` channel covers it — the token rides the upgrade URL.
- **POST:** `body.token` in the JSON body. Read via `req.clone().json()` (the clone preserves the original body for any downstream POST route handler — there are no POST routes in v1, but the clone makes the central check forward-safe). A POST that sends `?session=` in the URL is also accepted (superset; the primary POST channel is `body.token`).
- **Missing / wrong / malformed:** `false` → the caller returns **403**.

`randomUUID()` is the repo norm (`import { randomUUID } from "node:crypto"` — exactly how `pi-agent-ext-web-access/index.ts` mints its `sessionToken`). The compare is a flat `!==` (constant-time is not required for a loopback-only, per-session random token; timing attacks are not in the threat model).

### D2 — Central validation placement (`WebServer.setTokenAuth` DI)

Validation runs in `WebServer.fetch`, **after** the existing `originAllowed` guard and **before** the additive `this.httpRoutes` — so it covers the render data routes (`/api/*`), the SSE channel (`/api/events`), the `/ws` upgrade, and `/health`. This is the single chokepoint; no route can bypass it.

```ts
// WebServer gains a DI-by-setter (mirrors the existing setCommandHandler / setHttpRoutes):
export type TokenAuth = { readonly token: string; validateRequest(req: Request): Promise<boolean> };
setTokenAuth(auth: TokenAuth | null): void;   // null = pass-through (default)
```

- **`null` (default) = pass-through.** A bare `WebServer` with no auth set validates nothing — the standalone `web-server.test.ts` stub-page / origin-guard tests stay green unchanged.
- **Async `fetch`.** Because `validateRequest` is async (POST body read), `WebServer.fetch` becomes `async` (returns `Promise<Response>`). `Bun.serve` accepts an async `fetch`; all existing tests `await fetch(...)`, so this is transparent.
- **403 body.** On validation failure: `new Response("forbidden", { status: 403 })` — identical shape to the origin-guard 403, so clients see one consistent "denied" response.

### D3 — Shell bootstrap exemption (`GET /` is the ONE token-exempt route)

`GET /` — the render shell document — is **exempt** from token validation. It is the bootstrap that delivers the server-injected token (D4) to the browser, so it must load from the **announced base URL**, which carries no token (D6). Every other route requires the token.

```ts
// inside WebServer.fetch, after the origin guard:
if (this.tokenAuth && !(req.method === "GET" && url.pathname === "/")) {
  if (!(await this.tokenAuth.validateRequest(req))) return new Response("forbidden", { status: 403 });
}
```

This reconciles two facts that are individually load-bearing: (a) the token "covers render routes + `/health` + `/ws`" — meaning the render **data** routes (`/api/*`), `/api/events`, `/ws`, `/health`; and (b) "the announced URL is just the base URL" — which is only true if `GET /` loads without a token. The exemption is the one-liner that makes both hold. (`WebServer` already hardcodes knowledge of `/health`, `/`, `/ws`; exempting the bootstrap `GET /` from the token check is consistent with that.)

### D4 — Server-injected shell token

The render shell (ticket 06's `GET /` document) is generated with the token baked into its JS, so the client authenticates every subsequent `/api/*` fetch and the `/ws` upgrade:

```ts
// The shell's JS gains a server-injected constant the client uses verbatim:
//   const TOKEN = "<the-session-uuid>";
// and every data/WS call appends ?session=${TOKEN} (or ?session=${TOKEN} on the ws URL).
export function renderShellHtml(token: string): string;   // was the static RENDER_SHELL_HTML const
```

- The token is a UUID (hex + hyphens only) — safe inside a JS string literal and in HTML; no escaping needed.
- `createRenderRoutes(registry)` becomes `createRenderRoutes(registry, token)` so the `GET /` branch serves `renderShellHtml(token)`.
- The wiring mints the `TokenAuth` (D1) **once**, then threads `auth.token` into `createRenderRoutes(registry, auth.token)` and `auth` into `server.setTokenAuth(auth)` — one token, one source of truth.

### D5 — Port resolution (3-tier)

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

### D6 — Announce (`ctx.ui`, session_start, announce-only)

At `session_start`, after `server.start()`, the wiring surfaces the **resolved** URL to the TUI user via the SDK `ctx.ui` surface — the channel that actually reaches the user:

```ts
// inside the session_start handler (after server.start() + bindSession):
const url = server.url;                                  // the resolved loopback URL
sessionCtx.ui.notify(`webui: ${url}`, "info");
sessionCtx.ui.setStatus("webui", url);
```

- **Undo the `ctx` downcast.** The handler currently narrows `ctx` to `{ abort(): void }`, which drops `ctx.ui`. It is widened to a session-context interface that carries a mockable `ui` surface (D7), so the announce can reach it. (`bindSession` still receives the ctx — the widened shape is a structural superset of `{ abort() }`, so the existing bind is unchanged.)
- **Announce the resolved URL.** `server.url` is read **after** `server.start()`, so it reflects the actually-bound port (ephemeral or pinned). The announce fires on every `session_start` (startup / reload / new / resume / fork); `start()` is idempotent and the singleton persists, so the URL is stable across re-announces.
- **No auto-open.** The wiring **never** opens a browser — no `pi.exec("open" / "xdg-open" / "cmd /c start")` (the web-access `openInBrowser` pattern is explicitly **not** reused). The wiring's host interface exposes no `exec`, so it cannot call one; announce-only is the v1 posture.
- **No `console.log`.** `console.log` is a debug channel that does not reach the TUI user; the announce uses `ctx.ui.notify` / `setStatus` exclusively. (Using `ui` is also what makes the announce *testable* — the test asserts the `ui` surface was called, which a `console.log` would fail.)

### D7 — The `ui` surface shape (mirrors the SDK)

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

- **TokenAuth (pure):** per-channel valid/invalid/missing — GET `?session=` (valid → true; wrong → false; absent → false); POST `body.token` (valid → true; wrong → false; non-JSON/empty body → false); WS-upgrade URL `?session=` (valid → true); flat `!==` (no substring/prefix match). Token is a UUID-shaped string.
- **`WebServer.setTokenAuth` (live, bare server):** with auth set — request without token → 403; wrong token → 403; valid token → through to the route; `GET /` (bootstrap) → **200 even without a token** (the D3 exemption); `/health` with token → 200, without → 403; `/ws` upgrade without `?session=` → refused, with → upgraded. With auth unset (`null`) — every existing origin-guard / stub-page / route test unchanged (pass-through).
- **`resolvePort` (pure):** `WEBUI_PORT` honored; `PORT` honored when `WEBUI_PORT` absent; `WEBUI_PORT` wins when both set; neither → `0`; invalid (non-numeric / negative / out of range / empty) → falls through to `0`. Injectable env (no `process.env` mutation).
- **Announce (wiring):** after `session_start`, `ctx.ui.notify` called **once** with `webui: <resolved-url>` and type `"info"`; `ctx.ui.setStatus` called once with key `"webui"` and the resolved URL. With a real server, the URL is the live `http://127.0.0.1:<port>` (resolved, not the literal `0`). **No auto-open:** the host records `exec` calls and asserts zero (negative control). The shared `MockPi` ctx + every inline ctx fake gain a `ui` stub recording notify/setStatus.
- **Integration (live, through `wireWebui`):** `GET /` serves the shell with a `const TOKEN="…"` injected (bootstrap, no token needed); `/api/*` and `/api/events` **require** `?session=` (403 without, 200/SSE with — token extracted from the served shell HTML); `/ws` **requires** `?session=` in the upgrade URL (refused without, upgraded with). The announce fires. **Decoupling still holds (ticket 06 D8):** the auth/port/announce additions do not cause `sendUserMessage`, a `mutex_blocked`/chat frame, or any render→chat coupling.
- **Existing-test impact (expected, in-scope):** the render-shell and render-routes tests move from the static `RENDER_SHELL_HTML` const to `renderShellHtml(token)` / `createRenderRoutes(registry, token)` (thread the token arg). The live-smoke WS opens append `?session=<token>` (extracted from the served shell). The wiring-live-smoke `GET /` assertion stays green (the shell marker is still served).

## Out of Scope (v1)

- **Auto-open browser.** v1 is announce-only; the user opens the URL themselves. (The web-access `openInBrowser` / `pi.exec("open"/"xdg-open"/"cmd /c start")` pattern is deliberately **not** reused. A future ticket may add an opt-in auto-open.)
- **Persistent `appendEntry` transcript row** for the URL (so it survives `/reload` and compaction). v1 announces at each `session_start`; persistence is deferred.
- **`gui-registry`-style multi-webui discovery** (`<git-common-dir>/gui-servers.json`, pid-liveness-pruned, `--all`/`--json`). v1 is single-webui; the registry is deferred.
- **FNV-stable-per-worktree port.** v1 is `WEBUI_PORT` > `PORT` > ephemeral; deterministic-per-worktree hashing is deferred.
- **Remote / multi-user binding.** v1 is loopback-only (`127.0.0.1`); remote binding (and the TLS / stronger-auth it would require) is deferred.
- **Constant-time token compare.** Not required for a loopback-only, per-session random UUID; timing attacks are out of the threat model.
- **Bearer-header auth scheme.** Explicitly rejected — loopback + token is the posture; only `?session=` / `body.token` / WS-upgrade-URL channels are supported.
- **Defaulting to `8090`.** Explicitly rejected — `serveWithFallback` already skips held ports; `8090` (embed-mlx-server) is avoided without special-casing.
- **Token rotation / refresh** mid-session. v1 mints one token per wiring; rotation is deferred.
- **POST routes.** None exist in v1; `body.token` is supported centrally (D1) for forward-compatibility but no v1 route exercises it.

## Further Notes

- **Reuses ticket 04's `WebServer`** (loopback `originAllowed`, `serveWithFallback`, `setHttpRoutes` DI, `.unref()`) — no new server process, no change to the loopback posture. The only `fetch` change is inserting the token check (async) and the `GET /` exemption.
- **Reuses ticket 06's render shell** — the `GET /` document is unchanged in structure; it gains a `const TOKEN="…"` and its data/WS calls append `?session=${TOKEN}`. The shell is still a single inline HTML string (no build step, no committed artifacts).
- **Reuses web-access's token pattern** (`?session=` / `body.token` / 403 / `randomUUID`) — lifted into a pure, reusable `TokenAuth` rather than copied inline per route. web-access validates per-route (each route parses its body then calls `validateToken(body)`); webui validates **centrally** (one `WebServer.fetch` check before any route), which is stronger (no route can bypass it) and is why the check lives in the adapter, not in `createRenderRoutes`.
- **The announce is the user-facing discovery mechanism** — it is the analog of `gui-movie-director`'s `gui:port` (`scripts/gui-port.ts`), but delivered through the extension `ctx.ui` surface (so it reaches the TUI user) rather than printed to stdout. Announce-only (no `--all`/`--json` registry) for v1.
- **`ctx.ui` is on the session context, not the host.** `ExtensionAPI` has no `ui` member; `ExtensionContext` does. The announce widens the **session-context** type the wiring uses (`WebuiSessionCtx`), leaving the host interface (`WebuiHost`) unchanged — `on`, `sendUserMessage`, `events`, `registerTool`. The host gains no new members; in particular it gains **no `exec`** (which is what makes "no auto-open" structurally enforced).
