# webui Port, Binding, Auth & URL Discovery (Ticket 07) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the merged webui transport (ticket 04) + render framework (ticket 06) a per-session auth token, a 3-tier port choice, and a TUI-visible URL announcement — without coupling render to chat/mutex and without auto-opening a browser.

**Architecture:** A pure `createTokenAuth()` mints a `randomUUID()` session token and validates inbound requests (`?session=` for GET/WS, `body.token` for POST, flat `!==`, 403). `WebServer` gains a `setTokenAuth(auth | null)` DI setter (mirrors the existing `setHttpRoutes`/`setCommandHandler`); `fetch()` consults it **after** the loopback origin guard and **before** the additive `httpRoutes`, exempting only the `GET /` shell bootstrap (the document that delivers the token). The render shell is generated with the token baked in (`renderShellHtml(token)`) so the client appends `?session=` to every data/WS call. A pure `resolvePort()` picks `WEBUI_PORT` > `PORT` > `0`. At `session_start`, after `server.start()`, the wiring announces the resolved URL via the SDK `ctx.ui` surface (`notify` + `setStatus`) — widening the session-context type to reach `ctx.ui`, **no** `console.log`, **no** auto-open.

**Tech Stack:** `node:crypto` `randomUUID`, `Bun.serve` (existing `WebServer`, now with an async `fetch`), the SDK `ExtensionUIContext` (`ctx.ui.notify`/`setStatus`), TypeBox (unchanged), the existing vanilla render shell (now token-templated). No new runtime deps.

## Global Constraints

Copied verbatim from the spec decisions (every task's requirements implicitly include these):

- **Loopback-only.** Binding stays `127.0.0.1` (ticket 04, unchanged). No remote/multi-user binding.
- **Token channels (flat `!==`, 403 on mismatch — no Bearer scheme):** `?session=<token>` in the URL for GET and the WS upgrade; `body.token` in the JSON body for POST (read via `req.clone()` so a downstream POST route can still read the body). Missing/wrong/malformed → `false` → the caller returns **403**. Mirrors `pi-agent-ext-web-access`'s `validateToken`.
- **Token = `randomUUID()`** from `node:crypto` (repo norm — same as web-access). One token per wiring.
- **Central validation placement:** the token check runs in `WebServer.fetch` **after** the origin guard and **before** `this.httpRoutes` (covers `/api/*`, `/api/events`, `/ws`, `/health`). The ONE exempt route is `GET /` (the shell bootstrap that delivers the token). `null` auth = pass-through (bare server unchanged).
- **Server-injected shell token:** the shell HTML carries `const TOKEN="…"`; the client appends `?session=${TOKEN}` to `/api/*` + the `/ws` URL. The announced URL is the base URL (no token).
- **Port 3-tier:** `WEBUI_PORT` env > `PORT` env > `0` (OS-assigned ephemeral). `serveWithFallback` already skips held ports (so `8090` / embed-mlx-server is avoided) — **no default to 8090**.
- **Announce via `ctx.ui` only:** at `session_start`, after `server.start()`, call `ctx.ui.notify("webui: <url>", "info")` + `ctx.ui.setStatus("webui", "<url>")`. **`console.log` is NOT acceptable** (it does not reach the TUI user — debugging only).
- **No auto-open:** the wiring never calls `pi.exec("open"/"xdg-open"/"cmd /c start")`. The host interface exposes **no `exec`** — announce-only is the v1 posture.
- **⚠️ tsconfig-tests gotcha (memory 3be99b98):** the package `tsconfig.json` `include` is `src/**/*.ts` only — `bun run typecheck` does NOT typecheck `tests/`. Every task that widens an interface a test implements MUST update the test fixtures (the shared `MockPi` helper AND every inline `MockPi`/ctx fake) in the SAME task, and the conformance gate is the FULL `bun run typecheck && bun test` (never typecheck alone).

**Decomposition note (refinement of the ticket's suggested T-sets).** The ticket's "T2 — wire token into WebServer.fetch" suggested constructing `TokenAuth` inside `wireWebui` in T2. That is **refined here**: T2 adds the `WebServer.setTokenAuth` mechanism + bare-server unit tests but does **not** yet enable it in `wireWebui`, because enabling the token gate before the shell-token injection (T5) would 403 every live integration test (`render-integration`, `wiring-live-smoke`) that cannot yet present the token (it is a per-session `randomUUID` the tests can only read out of the served shell). T5 is where `wireWebui` constructs `TokenAuth`, calls `server.setTokenAuth`, threads the token into the shell, and updates those integration tests. Each task stays independently green.

## File Structure

**Create (all under `bun-apps/pi-agent-ext-webui/`):**
- `src/token-auth.ts` — pure `createTokenAuth()` → `{ token, validateRequest(req): Promise<boolean> }`. Single responsibility: mint + validate the session token.
- `src/port-resolver.ts` — pure `resolvePort(env?)` 3-tier resolver. Single responsibility: pick the requested port.
- `tests/token-auth.test.ts`, `tests/port-resolver.test.ts` — one test file per pure module.

**Modify:**
- `src/web-server.ts` (T2) — add the `TokenAuth` import, `tokenAuth` field, `setTokenAuth` setter, and consult it inside `fetch` (making `fetch` async, with the `GET /` exemption).
- `src/render-shell.ts` (T5) — `RENDER_SHELL_HTML` const → `renderShellHtml(token)` function; shell JS gains `const TOKEN="…"` + `?session=` on every data/WS call.
- `src/render-routes.ts` (T5) — `createRenderRoutes(registry)` → `createRenderRoutes(registry, token)`; `GET /` serves `renderShellHtml(token)`.
- `src/webui-wiring.ts` (T3, T4, T5) — T3: `getServer()` uses `resolvePort()`; T4: add `WebuiUi`/`WebuiSessionCtx`, widen the `session_start` handler to announce; T5: add `setTokenAuth` to `WebuiServer`, construct `TokenAuth`, call `server.setTokenAuth(auth)`, pass `auth.token` to `createRenderRoutes`, clear on `dispose`.
- `extensions/webui.ts` — **no change** (the cast `pi as unknown as WebuiHost` still holds; `ui` is on ctx, not the host).
- `tests/web-server.test.ts` (T2) — append a `WebServer setTokenAuth` describe block.
- `tests/helpers/mock-pi.ts` (T4) — `MockPi.ctx` gains a `ui` stub recording `notify`/`setStatus`.
- `tests/wiring-live-smoke.test.ts` (T4 + T5) — T4: inline `MockPi.ctx()` + `exec` recorder + announce test G; T5: WS opens append `?session=<token>` (extracted from the served shell).
- `tests/render-integration.test.ts` (T4 + T5) — T4: inline `MockPi.ctx()` ui stub; T5: `/api/*` + `/ws` calls append `?session=<token>`, `GET /` assertion checks the token is injected.
- `tests/render-routes.test.ts` (T5) — `setup()` passes a token to `createRenderRoutes`.
- `tests/render-shell.test.ts` (T5) — assert on `renderShellHtml(token)` (was `RENDER_SHELL_HTML`), incl. the injected `const TOKEN`.
- `tests/webui-wiring.test.ts` (T5) — `FakeWebServer` gains `setTokenAuth`; add an announce unit test.

---

### Task 1: TokenAuth (pure `createTokenAuth`)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/token-auth.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/token-auth.test.ts`

**Interfaces:**
- Consumes: `node:crypto` `randomUUID` (repo norm — `pi-agent-ext-web-access/index.ts:34,987`). The Fetch `Request` type (global, in `lib: ["DOM"]`).
- Produces (the type every later task imports from `./token-auth.js`):
  - `export interface TokenAuth { readonly token: string; validateRequest(req: Request): Promise<boolean> }`
  - `export function createTokenAuth(): TokenAuth`
  - **Behavior contract (spec D1):** `token` is a `randomUUID()`. `validateRequest` is **async** (POST body read is inherently async, which makes `WebServer.fetch` async in T2). Channels: `?session=<token>` in the URL (GET + WS upgrade — the WS upgrade is a GET, so the same channel covers it); `body.token` in the POST JSON body (read via `req.clone().json()` so the original body stays readable). Flat `!==`; no substring/prefix match. POST may also send `?session=` in the URL (superset). Missing/wrong/malformed → `false`.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/token-auth.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createTokenAuth } from "../src/token-auth.js";

describe("createTokenAuth", () => {
  it("mints a UUID-shaped token", () => {
    const auth = createTokenAuth();
    expect(auth.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("mints a fresh token each call", () => {
    expect(createTokenAuth().token).not.toBe(createTokenAuth().token);
  });

  it("GET with ?session=<token> -> true", async () => {
    const auth = createTokenAuth();
    const req = new Request(`http://127.0.0.1:1/api/views?session=${auth.token}`);
    expect(await auth.validateRequest(req)).toBe(true);
  });

  it("GET with ?session=<wrong> -> false", async () => {
    const auth = createTokenAuth();
    const req = new Request("http://127.0.0.1:1/api/views?session=wrong");
    expect(await auth.validateRequest(req)).toBe(false);
  });

  it("GET with no ?session= -> false", async () => {
    const auth = createTokenAuth();
    const req = new Request("http://127.0.0.1:1/api/views");
    expect(await auth.validateRequest(req)).toBe(false);
  });

  it("WS-upgrade URL with ?session=<token> -> true (GET channel)", async () => {
    const auth = createTokenAuth();
    const req = new Request(`ws://127.0.0.1:1/ws?session=${auth.token}`);
    expect(await auth.validateRequest(req)).toBe(true);
  });

  it("WS-upgrade URL with ?session=<wrong> -> false", async () => {
    const auth = createTokenAuth();
    const req = new Request("ws://127.0.0.1:1/ws?session=wrong");
    expect(await auth.validateRequest(req)).toBe(false);
  });

  it("POST with body.token=<token> -> true", async () => {
    const auth = createTokenAuth();
    const req = new Request("http://127.0.0.1:1/api/x", {
      method: "POST",
      body: JSON.stringify({ token: auth.token, payload: 1 }),
    });
    expect(await auth.validateRequest(req)).toBe(true);
  });

  it("POST with body.token=<wrong> -> false", async () => {
    const auth = createTokenAuth();
    const req = new Request("http://127.0.0.1:1/api/x", {
      method: "POST",
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(await auth.validateRequest(req)).toBe(false);
  });

  it("POST with non-JSON body -> false", async () => {
    const auth = createTokenAuth();
    const req = new Request("http://127.0.0.1:1/api/x", {
      method: "POST",
      body: "not-json",
    });
    expect(await auth.validateRequest(req)).toBe(false);
  });

  it("flat !== compare (no substring/prefix match)", async () => {
    const auth = createTokenAuth();
    const req = new Request(
      `http://127.0.0.1:1/api/views?session=${auth.token.slice(0, 4)}`
    );
    expect(await auth.validateRequest(req)).toBe(false);
  });

  it("validateRequest does NOT consume a POST body (clone preserves it)", async () => {
    const auth = createTokenAuth();
    const req = new Request("http://127.0.0.1:1/api/x", {
      method: "POST",
      body: JSON.stringify({ token: auth.token, payload: { a: 1 } }),
    });
    expect(await auth.validateRequest(req)).toBe(true);
    // the original body is still readable for a downstream route handler.
    const body = (await req.json()) as { token: string; payload: { a: number } };
    expect(body).toEqual({ token: auth.token, payload: { a: 1 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/token-auth.test.ts )`
Expected: FAIL — `Cannot find module "../src/token-auth.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `bun-apps/pi-agent-ext-webui/src/token-auth.ts`:

```ts
/**
 * token-auth.ts — the per-session token auth (specs/07 D1).
 *
 * Pure: uses node:crypto randomUUID + URL parsing; no `bun`, no `pi`. Mirrors
 * pi-agent-ext-web-access's validateToken (?session= / body.token / 403), lifted
 * into a reusable, testable unit. The compare is a flat !== (loopback-only,
 * per-session random UUID — timing attacks are out of scope; no Bearer scheme).
 *
 * Channels:
 *   GET / WS upgrade: ?session=<token> in the request URL (the WS upgrade is a
 *                     GET, so this channel covers it too).
 *   POST:             body.token in the JSON body — read via req.clone() so the
 *                     original body stays readable for a downstream POST route.
 *   else:             false -> the caller returns 403.
 *
 * validateRequest is async because reading the POST body is async; this makes
 * WebServer.fetch async in T2 (Bun.serve accepts an async fetch).
 */
import { randomUUID } from "node:crypto";

export interface TokenAuth {
  /** The session token (UUID-shaped). Bake into the render shell (D4). */
  readonly token: string;
  /** True iff the request carries the token on one of its channels. */
  validateRequest(req: Request): Promise<boolean>;
}

export function createTokenAuth(): TokenAuth {
  const token = randomUUID();
  return {
    token,
    async validateRequest(req: Request): Promise<boolean> {
      const url = new URL(req.url);
      // GET / WS-upgrade channel: ?session= in the URL.
      if (url.searchParams.get("session") === token) return true;
      // POST channel: body.token in the JSON body (clone preserves the original
      // so a downstream POST route can still read it).
      if (req.method === "POST") {
        try {
          const body = (await req.clone().json()) as { token?: unknown };
          if (body?.token === token) return true;
        } catch {
          // not JSON / no body -> not a valid POST-token channel
        }
      }
      return false;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/token-auth.test.ts )`
Expected: PASS — all 12 cases green.

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/token-auth.ts bun-apps/pi-agent-ext-webui/tests/token-auth.test.ts
git commit -m "feat(webui): add pure createTokenAuth session-token validator (ticket 07 D1)"
```

---

### Task 2: `setTokenAuth` mechanism on `WebServer` (DI; not yet wired)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/web-server.ts` (import `TokenAuth`; add `tokenAuth` field + `setTokenAuth` setter; consult it inside `fetch`, making `fetch` async, with the `GET /` exemption)
- Test: `bun-apps/pi-agent-ext-webui/tests/web-server.test.ts` (append a `WebServer setTokenAuth` describe block + import `createTokenAuth`)

**Interfaces:**
- Consumes: `TokenAuth` from `./token-auth.js` (T1); the existing `WebServer.fetch(req, srv: Server<undefined>)` and the inline `originAllowed` guard.
- Produces:
  - `WebServer.setTokenAuth(auth: TokenAuth | null): void` — DI setter (mirrors `setHttpRoutes`/`setCommandHandler`). `null` (default) = pass-through; a bare `WebServer` validates nothing.
  - **Behavior contract (spec D2/D3):** `fetch` consults the auth **after** the origin guard and **before** `this.httpRoutes`. `GET /` (the shell bootstrap) is **exempt** — it is the document that delivers the token, so it must load from the token-less base URL. Every other path requires the token; failure → `new Response("forbidden", { status: 403 })` (same shape as the origin-guard 403). `fetch` is now `async` (returns `Promise<Response>`); `Bun.serve` accepts an async `fetch`, and the WS upgrade still works (Bun keeps the request alive across the `await`).
- **Does NOT touch `wireWebui`** — enabling the gate is T5 (see the decomposition note). Every existing test uses a bare server (no `setTokenAuth`) → pass-through → green.

- [ ] **Step 1: Write the failing test**

Append to `bun-apps/pi-agent-ext-webui/tests/web-server.test.ts`. First add the import at the top (with the other `../src/...` imports):

```ts
import { createTokenAuth } from "../src/token-auth.js";
```

Then append this describe block at the end of the file (it reuses the file's existing `makeServer`, `withTimeout`, `waitFor`, `openWs` helpers):

```ts
// --- WebServer setTokenAuth (ticket 07 central auth) -----------------------

describe("WebServer setTokenAuth", () => {
  it("without a token -> 403 on a gated route (/health)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setTokenAuth(createTokenAuth());
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(403);
  });

  it("wrong token -> 403", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setTokenAuth(createTokenAuth());
    const res = await fetch(`${s.url}/health?session=wrong`);
    expect(res.status).toBe(403);
  });

  it("valid token -> through to /health", async () => {
    const auth = createTokenAuth();
    const s = makeServer({ port: 0 });
    s.start();
    s.setTokenAuth(auth);
    const res = await fetch(`${s.url}/health?session=${auth.token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET / (the shell bootstrap) is EXEMPT -> 200 even without a token", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setTokenAuth(createTokenAuth());
    const res = await fetch(`${s.url}/`);
    expect(res.status).toBe(200); // serves the stub page (no routes installed)
    expect(await res.text()).toContain("webui connect-test");
  });

  it("WS upgrade without ?session= -> refused (client never opens)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setTokenAuth(createTokenAuth());
    let opened = false;
    let settled = false;
    const ws = new WebSocket(`${s.url.replace("http", "ws")}/ws`);
    ws.onopen = () => { opened = true; settled = true; };
    ws.onerror = () => { settled = true; };
    ws.onclose = () => { settled = true; };
    await withTimeout(
      (async () => { while (!settled) await Bun.sleep(5); })(),
      2000,
      "ws denial never settled"
    );
    expect(opened).toBe(false);
  });

  it("WS upgrade with ?session=<token> -> upgraded (client opens)", async () => {
    const auth = createTokenAuth();
    const s = makeServer({ port: 0 });
    s.start();
    s.setTokenAuth(auth);
    const ws = await withTimeout(
      openWs(`${s.url.replace("http", "ws")}/ws?session=${auth.token}`),
      2000,
      "ws open timed out"
    );
    await waitFor("client registered", () => s.clientCount === 1);
    expect(s.clientCount).toBe(1);
  });

  it("setTokenAuth(null) removes the gate (pass-through)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setTokenAuth(createTokenAuth());
    s.setTokenAuth(null);
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("with no auth set, existing routes are unchanged (pass-through)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-server.test.ts )`
Expected: FAIL — `TypeError: s.setTokenAuth is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `bun-apps/pi-agent-ext-webui/src/web-server.ts`:

3a. Add the import near the existing `./protocol.js` import:

```ts
import type { TokenAuth } from "./token-auth.js";
```

3b. Add the field. In the `WebServer` class, next to `private httpRoutes: HttpRouteHandler | null = null;` add:

```ts
  private tokenAuth: TokenAuth | null = null;
```

3c. Add the setter. Next to the existing `setHttpRoutes(handler)` method add:

```ts
  /**
   * Inject the per-session token auth (ticket 07 D2). `fetch()` consults it
   * after the origin guard and before the additive routes; `null` removes it
   * (default = pass-through, so a bare WebServer validates nothing).
   */
  setTokenAuth(auth: TokenAuth | null): void {
    this.tokenAuth = auth;
  }
```

3d. Make `fetch` async + insert the token check. Replace the existing `private fetch(req: Request, srv: Server<undefined>): Response {` method header and the origin-guard + httpRoutes preamble with the async version. The exact replacement — find:

```ts
  private fetch(req: Request, srv: Server<undefined>): Response {
    const url = new URL(req.url);
    // Shared origin guard (spec §2): the same check gates HTTP fetch AND the WS
    // upgrade (the /ws branch below). Absent Origin is allowed.
    const origin = req.headers.get("origin");
    if (origin && !originAllowed(origin, req.headers.get("host"))) {
      return new Response("forbidden", { status: 403 });
    }
    if (this.httpRoutes) {
```

and replace with:

```ts
  private async fetch(req: Request, srv: Server<undefined>): Promise<Response> {
    const url = new URL(req.url);
    // Shared origin guard (spec §2): the same check gates HTTP fetch AND the WS
    // upgrade (the /ws branch below). Absent Origin is allowed.
    const origin = req.headers.get("origin");
    if (origin && !originAllowed(origin, req.headers.get("host"))) {
      return new Response("forbidden", { status: 403 });
    }
    // Token auth (ticket 07 D2/D3): central check, AFTER the origin guard and
    // BEFORE the additive httpRoutes — covers /api/*, /api/events, /ws, /health.
    // GET / (the render shell bootstrap) is EXEMPT: it delivers the server-
    // injected token to the browser, so it must load from the token-less base
    // URL (the announced URL carries no token). async because validateRequest
    // may read a POST body; Bun.serve keeps the request (and the WS upgrade)
    // alive across the await.
    if (this.tokenAuth && !(req.method === "GET" && url.pathname === "/")) {
      if (!(await this.tokenAuth.validateRequest(req))) {
        return new Response("forbidden", { status: 403 });
      }
    }
    if (this.httpRoutes) {
```

(Leave the rest of `fetch` — the `/health`, `/`, `/ws`, not-found branches — unchanged. The `if (this.httpRoutes) { const res = this.httpRoutes(req, srv); if (res) return res; }` block stays valid inside the now-async function: `httpRoutes` is still a sync `Response | null`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-server.test.ts )`
Expected: PASS — all existing origin-guard / stub-page / WS / broadcast cases plus the 8 new `setTokenAuth` cases green. (Existing cases use a bare server with no `setTokenAuth` → pass-through → unchanged behavior; the async `fetch` is transparent because the hot path has no `await` when `tokenAuth` is null.)

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/web-server.ts bun-apps/pi-agent-ext-webui/tests/web-server.test.ts
git commit -m "feat(webui): add setTokenAuth DI setter + central token check to WebServer.fetch (ticket 07 D2/D3)"
```

---

### Task 3: Port resolution (3-tier `resolvePort`)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/port-resolver.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (`getServer()` uses `resolvePort()` instead of the hardcoded `port: 0`)
- Test: `bun-apps/pi-agent-ext-webui/tests/port-resolver.test.ts`

**Interfaces:**
- Consumes: nothing (pure; takes an injectable env so tests are deterministic — no `process.env` mutation).
- Produces:
  - `export function resolvePort(env?: Record<string, string | undefined>): number` — `WEBUI_PORT` > `PORT` > `0`. Invalid (non-integer / out of `[1,65535]` / empty) falls through to the next tier, ultimately `0`. Default env source: `process.env`.
  - **Behavior contract (spec D5):** `serveWithFallback` (web-server.ts) already walks `port..port+50` on `EADDRINUSE`, so held ports — notably `8090` (embed-mlx-server LaunchAgent) — are inherently avoided. There is **no default to 8090**. The singleton constructor is changed from `port: 0` to `port: resolvePort()`; `resolvePort()` is called lazily (first `getServer()`), so test runs with neither env var set still get an ephemeral port.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/port-resolver.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { resolvePort } from "../src/port-resolver.js";

describe("resolvePort", () => {
  it("WEBUI_PORT is honored", () => {
    expect(resolvePort({ WEBUI_PORT: "8080" })).toBe(8080);
  });

  it("PORT is honored when WEBUI_PORT is absent", () => {
    expect(resolvePort({ PORT: "9000" })).toBe(9000);
  });

  it("WEBUI_PORT wins over PORT when both are set", () => {
    expect(resolvePort({ WEBUI_PORT: "8080", PORT: "9000" })).toBe(8080);
  });

  it("neither set -> 0 (ephemeral)", () => {
    expect(resolvePort({})).toBe(0);
  });

  it("WEBUI_PORT non-numeric -> falls through to PORT", () => {
    expect(resolvePort({ WEBUI_PORT: "abc", PORT: "9000" })).toBe(9000);
  });

  it("WEBUI_PORT out of range (high) -> falls through", () => {
    expect(resolvePort({ WEBUI_PORT: "99999", PORT: "9000" })).toBe(9000);
  });

  it("WEBUI_PORT negative -> falls through", () => {
    expect(resolvePort({ WEBUI_PORT: "-5", PORT: "9000" })).toBe(9000);
  });

  it("WEBUI_PORT empty -> falls through", () => {
    expect(resolvePort({ WEBUI_PORT: "", PORT: "9000" })).toBe(9000);
  });

  it("both invalid -> 0", () => {
    expect(resolvePort({ WEBUI_PORT: "abc", PORT: "xyz" })).toBe(0);
  });

  it("does NOT default to 8090", () => {
    expect(resolvePort({})).toBe(0);
    expect(resolvePort({})).not.toBe(8090);
  });

  it("defaults to process.env when no arg given (unset in the runner -> 0)", () => {
    expect(resolvePort()).toBe(0);
    expect(typeof resolvePort()).toBe("number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/port-resolver.test.ts )`
Expected: FAIL — `Cannot find module "../src/port-resolver.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `bun-apps/pi-agent-ext-webui/src/port-resolver.ts`:

```ts
/**
 * port-resolver.ts — 3-tier port selection (specs/07 D5).
 *
 * Pure: takes an injectable env (default process.env) so tests are deterministic
 * (no process.env mutation). WEBUI_PORT > PORT > 0 (OS-assigned ephemeral).
 * Invalid values (non-integer / out of [1,65535] / empty) fall through to the
 * next tier, and ultimately to 0.
 *
 * serveWithFallback (web-server.ts) already walks port..port+50 on EADDRINUSE,
 * so held ports — notably 8090 (embed-mlx-server LaunchAgent) — are inherently
 * avoided. There is NO default to 8090.
 */
const MAX_PORT = 65535;

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PORT) return null;
  return n;
}

export function resolvePort(
  env: Record<string, string | undefined> = process.env
): number {
  return parsePort(env.WEBUI_PORT) ?? parsePort(env.PORT) ?? 0;
}
```

- [ ] **Step 4: Wire into the singleton.** In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, add the import near the other `./...js` imports:

```ts
import { resolvePort } from "./port-resolver.js";
```

and change `getServer()` from the hardcoded ephemeral to the resolver. Find:

```ts
function getServer(): WebServer {
  if (!singletonServer) singletonServer = new WebServer({ port: 0 });
  return singletonServer;
}
```

and replace with:

```ts
function getServer(): WebServer {
  if (!singletonServer) singletonServer = new WebServer({ port: resolvePort() });
  return singletonServer;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/port-resolver.test.ts )`
Expected: PASS — all 11 cases green.

- [ ] **Step 6: Run the wiring suite to confirm no regression**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: PASS. The singleton-identity test calls `wireWebui(pi)` with no injected server → `getServer()` → `resolvePort()` (no env in the runner) → `0` → ephemeral → `instances[0].port > 0` still holds.

- [ ] **Step 7: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/port-resolver.ts bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/port-resolver.test.ts
git commit -m "feat(webui): add resolvePort 3-tier port resolver + wire into singleton (ticket 07 D5)"
```

---

### Task 4: Announce via `ctx.ui` at `session_start` (no auto-open)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (add `WebuiUi`/`WebuiSessionCtx`; widen the `session_start` handler to announce)
- Modify: `bun-apps/pi-agent-ext-webui/tests/helpers/mock-pi.ts` (`MockPi.ctx` gains a `ui` stub recording `notify`/`setStatus`)
- Modify: `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts` (inline `MockPi.ctx()` ui + `exec` recorder; add announce test G)
- Modify: `bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts` (inline `MockPi.ctx()` ui stub — needed because its tests call `session_start`)
- Test: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` (add an announce unit test)

**Interfaces:**
- Consumes: the SDK `ExtensionContext.ui: ExtensionUIContext` — verified `notify(message: string, type?: "info"|"warning"|"error"): void` and `setStatus(key: string, text: string | undefined): void` (`dist/core/extensions/types.d.ts`). The `WebuiServer.url` getter (throws before `start()`, valid after — read post-`start()`).
- Produces:
  - `export interface WebuiUi { notify(message: string, type?: "info" | "warning" | "error"): void; setStatus(key: string, text: string | undefined): void }` — the mockable announce surface (in `webui-wiring.ts`).
  - `export interface WebuiSessionCtx { abort(): void; ui: WebuiUi }` — the widened session-context type. This **undoes** the prior `ctx as { abort(): void }` downcast so the handler can reach `ctx.ui`. (`ui` lives on the **session context**, the 2nd arg to `session_start` — NOT on the host; `ExtensionAPI` has no `ui`. The host interface `WebuiHost` is unchanged — it gains no `exec`, which is what makes "no auto-open" structurally enforced.)
  - **Behavior contract (spec D6/D7):** at `session_start`, after `server.start()` + `bindSession`, the handler reads `server.url` (resolved) and calls `sessionCtx.ui.notify(\`webui: ${url}\`, "info")` + `sessionCtx.ui.setStatus("webui", url)`. No `console.log`; no `pi.exec` (no auto-open).

- [ ] **Step 1: Write the failing test**

1a. In `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts`, add an announce case inside the existing `describe("wireWebui — lifecycle", () => { … })` block (after the `session_shutdown` test):

```ts
  test("session_start announces the resolved URL via ctx.ui (notify + setStatus)", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    // FakeWebServer.url is "http://fake.local/".
    expect(pi.ctx.notifications).toEqual([
      { message: "webui: http://fake.local/", type: "info" },
    ]);
    expect(pi.ctx.statuses).toEqual([
      { key: "webui", text: "http://fake.local/" },
    ]);
  });
```

1b. In `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts`, add a Tier-A announce case after test E2 (inside `describe("wireWebui live smoke — Tier A", ...)`):

```ts
  it("G) session_start announces the resolved URL via ctx.ui, and does NOT auto-open", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // The announce uses the REAL resolved URL (live ephemeral port, not the
    // literal 0). ctx.ui.notify + setStatus each fire once.
    expect(pi.uiNotifications).toEqual([
      { message: `webui: ${server.url}`, type: "info" },
    ]);
    expect(pi.uiStatuses).toEqual([{ key: "webui", text: server.url }]);
    // No auto-open: the wiring never calls pi.exec (the host interface exposes
    // no exec). The exec recorder is a belt-and-suspenders negative control.
    expect(pi.execCalls).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts tests/wiring-live-smoke.test.ts )`
Expected: FAIL — `webui-wiring.test.ts`: `pi.ctx.notifications` is undefined (MockPi.ctx has no ui yet) → the session_start handler throws reaching `ctx.ui`. `wiring-live-smoke.test.ts`: `pi.uiNotifications` is undefined / handler throws on `ctx.ui`.

- [ ] **Step 3: Write minimal implementation**

3a. In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, add the two interfaces immediately after the existing `RenderHostEvents` interface:

```ts
/**
 * The TUI UI surface the announce uses (ticket 07 D6/D7). Mirrors exactly the
 * two ExtensionUIContext members the announce calls (verified against the SDK
 * dist .d.ts): notify(message, type) + setStatus(key, text). `ui` lives on the
 * SESSION CONTEXT (the 2nd arg to session_start), NOT on the host — the SDK
 * ExtensionAPI has no `ui` member; ExtensionContext does. Narrow on purpose so
 * a MockPi ctx stub is tiny; the real ExtensionContext is a structural superset.
 */
export interface WebuiUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

/**
 * The session-context slice the wiring touches: abort() (unchanged — the
 * dispatch closure + bindSession still use it) + ui (new — the announce
 * channel). Widening this UNDOES the prior `ctx as { abort(): void }` downcast
 * so session_start can reach ctx.ui (specs/07 D6).
 */
export interface WebuiSessionCtx {
  abort(): void;
  ui: WebuiUi;
}
```

3b. Widen the `session_start` handler. Find:

```ts
  reg("session_start", (_event, ctx) => {
    server.start();
    const sessionCtx = ctx as { abort(): void };
    server.bindSession(pi, sessionCtx);
    bound = { pi, ctx: sessionCtx };
  });
```

and replace with:

```ts
  reg("session_start", (_event, ctx) => {
    server.start();
    const sessionCtx = ctx as WebuiSessionCtx;
    server.bindSession(pi, sessionCtx);
    bound = { pi, ctx: sessionCtx };
    // ticket 07 announce (specs/07 D6): surface the RESOLVED URL to the TUI user
    // via the SDK ui surface (notify + setStatus). NO console.log (it does not
    // reach the TUI user — debugging only); NO auto-open (the host exposes no
    // exec). server.url is read AFTER start(), so it reflects the bound port
    // (ephemeral or pinned). start() is idempotent + the singleton persists, so
    // re-announces on reload/new/resume/fork show the same stable URL.
    const url = server.url;
    sessionCtx.ui.notify(`webui: ${url}`, "info");
    sessionCtx.ui.setStatus("webui", url);
  });
```

3c. Update the shared `MockPi` in `bun-apps/pi-agent-ext-webui/tests/helpers/mock-pi.ts`. Two surgical changes:

  **(i)** Extend the type-only import to also bring `WebuiUi`:

```ts
import type { RenderHostEvents, WebuiUi } from "../../src/webui-wiring.js";
```

  **(ii)** Change `MockPi.ctx` from an inline-initialized field (`readonly ctx = { abortCalls: 0, abort() { … } }`) to a **typed declaration with no initializer**, and **append** the ctx-building lines to the END of the existing constructor (the constructor already builds `this.events` — leave that block untouched; only ADD the ctx lines after it). The field becomes:

```ts
  /** Mock session context (the second arg passed to handlers). Adds a `ui`
   *  stub (ticket 07) recording notify/setStatus for announce assertions. */
  readonly ctx: {
    abortCalls: number;
    abort(): void;
    notifications: Array<{ message: string; type?: string }>;
    statuses: Array<{ key: string; text: string | undefined }>;
    ui: WebuiUi;
  };
```

  and at the end of the existing `constructor() { … this.events = { … }; }`, append:

```ts
    // ticket 07: ctx gains a ui stub that records announce calls. The arrays
    // are captured by the ui closures AND exposed on ctx (same references), so
    // pi.ctx.notifications / pi.ctx.statuses reflect every announce in tests.
    const notifications: Array<{ message: string; type?: string }> = [];
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    this.ctx = {
      abortCalls: 0,
      notifications,
      statuses,
      abort(): void {
        this.abortCalls++;
      },
      ui: {
        notify: (message, type) => {
          notifications.push({ message, type });
        },
        setStatus: (key, text) => {
          statuses.push({ key, text });
        },
      },
    };
```

  (`abort()` keeps using `this.abortCalls++` — inside the object literal `this` is the ctx object, exactly as the prior inline form did. The `readonly events: RenderHostEvents;` declaration + its existing constructor assignment are unchanged.)

3d. Update the inline `MockPi` in `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts`. Extend its import to bring `WebuiUi`:

```ts
import {
  wireWebui,
  type WebuiHost,
  type WebuiWiring,
  type RenderHostEvents,
  type WebuiUi,
} from "../src/webui-wiring.js";
```

In the inline `class MockPi implements WebuiHost { … }`, add announce + exec recording fields, replace `ctx()`, and add an `exec` recorder. Add these fields next to `aborts = 0;`:

```ts
  aborts = 0;
  // ticket 07 announce recording (populated by ctx(); fresh per session_start):
  uiNotifications: Array<{ message: string; type?: string }> = [];
  uiStatuses: Array<{ key: string; text: string | undefined }> = [];
  // ticket 07 no-auto-open negative control (the host interface exposes no
  // exec; this recorder asserts the wiring never reaches for one):
  execCalls = 0;
```

Replace the `ctx()` method:

```ts
  ctx(): { abort(): void; ui: WebuiUi } {
    const self = this;
    // fresh recording arrays per ctx() (each session_start gets a clean slate);
    // exposed on the instance for assertions.
    self.uiNotifications = [];
    self.uiStatuses = [];
    return {
      abort() {
        self.aborts++;
      },
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          self.uiNotifications.push({ message, type });
        },
        setStatus: (key: string, text: string | undefined) => {
          self.uiStatuses.push({ key, text });
        },
      },
    };
  }
```

and add the `exec` recorder method (a superset member — `WebuiHost` deliberately does NOT declare `exec`):

```ts
  /** Records exec calls (ticket 07 no-auto-open negative control). NOT on
   *  WebuiHost — the wiring cannot call it through the typed host. */
  async exec(_command: string, _args: string[]): Promise<{ code: number; stderr: string }> {
    this.execCalls++;
    return { code: 0, stderr: "" };
  }
```

3e. Update the inline `MockPi` in `bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts` so its `ctx()` returns a `ui` stub (its tests call `session_start`). Extend its import identically:

```ts
import {
  wireWebui,
  type WebuiHost,
  type WebuiWiring,
  type RenderHostEvents,
  type WebuiUi,
} from "../src/webui-wiring.js";
```

and replace its `ctx()` method with:

```ts
  ctx(): { abort(): void; ui: WebuiUi } {
    const self = this;
    return {
      abort() {
        self.aborts++;
      },
      ui: {
        notify: (_message: string, _type?: "info" | "warning" | "error") => {
          /* announce recording not asserted in this suite; stub satisfies the
           * widened WebuiSessionCtx so session_start can reach ctx.ui. */
        },
        setStatus: (_key: string, _text: string | undefined) => {
          /* same */
        },
      },
    };
  }
```

- [ ] **Step 4: Run the wiring + live-smoke + integration suites to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts tests/wiring-live-smoke.test.ts tests/render-integration.test.ts )`
Expected: PASS — the new announce cases green; every existing lifecycle / live-smoke / render-integration case green (the announce fires silently where not asserted; `ctx.ui` is now present everywhere).

- [ ] **Step 5: Typecheck (NOT sufficient alone — see Step 6)**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0). (This only covers `src/`; the test-fixture updates above are what keep `tests/` valid — the full gate is Step 6.)

- [ ] **Step 6: Run the FULL suite (the real conformance gate — tsconfig-tests gotcha)**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`
Expected: PASS — every test file green.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/helpers/mock-pi.ts bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts
git commit -m "feat(webui): announce resolved URL via ctx.ui at session_start (no auto-open) (ticket 07 D6/D7)"
```

---

### Task 5: Enable auth in `wireWebui` + server-injected shell token + integration tests green

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/render-shell.ts` (`RENDER_SHELL_HTML` const → `renderShellHtml(token)`; shell JS gains `const TOKEN="…"` + `?session=` on data/WS calls)
- Modify: `bun-apps/pi-agent-ext-webui/src/render-routes.ts` (`createRenderRoutes(registry)` → `createRenderRoutes(registry, token)`; `GET /` serves `renderShellHtml(token)`)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (add `setTokenAuth` to `WebuiServer`; construct `TokenAuth`; call `server.setTokenAuth(auth)`; pass `auth.token` to `createRenderRoutes`; clear on `dispose`)
- Modify: `bun-apps/pi-agent-ext-webui/tests/render-shell.test.ts` (assert on `renderShellHtml(token)`, incl. the injected `const TOKEN`)
- Modify: `bun-apps/pi-agent-ext-webui/tests/render-routes.test.ts` (`setup()` passes a token to `createRenderRoutes`)
- Modify: `bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts` (`/api/*` + `/ws` calls append `?session=<token>` extracted from the served shell; `GET /` assertion checks the token is injected)
- Modify: `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts` (WS opens append `?session=<token>` extracted from the served shell)
- Modify: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` (`FakeWebServer` gains `setTokenAuth`)

**Interfaces:**
- Consumes: `createTokenAuth` from `./token-auth.js` (T1); `WebServer.setTokenAuth` (T2); `RenderService` + the existing `createRenderRoutes` (ticket 06).
- Produces:
  - `export function renderShellHtml(token: string): string` (replaces the `RENDER_SHELL_HTML` const). The shell JS contains `const TOKEN = "<token>";` and a `SESSION_QS = "?session=" + encodeURIComponent(TOKEN)` appended to `/api/views`, `/api/view/:id`, `/api/events` (EventSource), and the `/ws` URL.
  - `export function createRenderRoutes(registry: RenderService, token: string): RenderRouteHandler` — the `GET /` branch returns `renderShellHtml(token)`.
  - Widened `WebuiServer`: adds `setTokenAuth(auth: TokenAuth | null): void`.
  - Wired `wireWebui`: constructs `const auth = createTokenAuth();`, calls `server.setTokenAuth(auth)`, passes `auth.token` to `createRenderRoutes(registry, auth.token)`; `dispose()` calls `server.setTokenAuth(null)`.

- [ ] **Step 1: Write/extend the failing tests**

1a. Rewrite `bun-apps/pi-agent-ext-webui/tests/render-shell.test.ts` to assert on `renderShellHtml(token)`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { renderShellHtml } from "../src/render-shell.js";
import { RenderService } from "../src/render-service.js";

const started: WebServer[] = [];
function makeServer(): WebServer {
  const s = new WebServer({ port: 0 });
  started.push(s);
  return s;
}
afterEach(() => {
  while (started.length) {
    try {
      started.pop()!.stop();
    } catch {
      /* ignore */
    }
  }
});

describe("renderShellHtml(token)", () => {
  it("is a complete HTML document with the marker, tabs pane, content pane, and SSE client", () => {
    const html = renderShellHtml("tok-123");
    expect(html).toContain("<!-- webui-render-shell -->");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="tabs"');
    expect(html).toContain('id="content"');
    expect(html).toContain("EventSource(");
    expect(html).toContain("/api/view/");
  });

  it("sandboxes html-mode content (iframe sandbox attribute, no allow-scripts)", () => {
    const html = renderShellHtml("tok-123");
    expect(html).toContain("setAttribute('sandbox', '')");
    expect(html).not.toContain("allow-scripts");
  });

  it("injects the token as a JS const the client appends as ?session=", () => {
    const html = renderShellHtml("abc-123-token");
    expect(html).toContain('const TOKEN = "abc-123-token";');
    expect(html).toContain("?session=' + encodeURIComponent(TOKEN)");
  });
});

describe("createRenderRoutes — GET / serves the shell", () => {
  it("GET / returns 200 text/html with the token injected", async () => {
    const registry = new RenderService();
    const server = makeServer();
    server.setHttpRoutes(createRenderRoutes(registry, "tok-123"));
    server.start();
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("webui-render-shell");
    expect(body).toContain('const TOKEN = "tok-123";');
  });

  it("GET / is served BEFORE /api/* (does not shadow api routes)", async () => {
    const registry = new RenderService();
    registry.render({ content: "# x", view: "main" });
    const server = makeServer();
    server.setHttpRoutes(createRenderRoutes(registry, "tok"));
    server.start();
    const shell = await (await fetch(`${server.url}/`)).text();
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(shell).toContain("webui-render-shell");
    expect(views.length).toBe(1);
  });
});
```

1b. In `bun-apps/pi-agent-ext-webui/tests/render-routes.test.ts`, thread a token through `setup()`:

```ts
function setup(now = () => 1000): { registry: RenderService; server: WebServer } {
  const registry = new RenderService({ urlFor: (id) => `http://t/#${id}`, now });
  const server = makeServer({ port: 0 });
  server.setHttpRoutes(createRenderRoutes(registry, "route-test-token"));
  server.start();
  return { registry, server };
}
```

(No other change to `render-routes.test.ts` — it uses a bare server with no `setTokenAuth`, so `/api/*` stays pass-through; the token is only threaded into the served shell, which no case here inspects.)

1c. In `bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts`, add a `shellToken` helper and thread `?session=` through every gated fetch/WS. Add the helper near the other harness helpers:

```ts
/** Extract the server-injected token from the served shell (GET / is the
 *  token-exempt bootstrap). The wiring mints a fresh randomUUID per session. */
async function shellToken(server: WebServer): Promise<string> {
  const html = await (await fetch(`${server.url}/`)).text();
  const m = html.match(/const TOKEN = "([^"]+)";/);
  if (!m) throw new Error("TOKEN not found in served shell");
  return m[1];
}
```

Then update the existing cases:

- "registers the webui_render tool + webui:render subscription" — change the `/api/view/preview` fetch to carry the token:

```ts
    pi.events.emit("webui:render", { content: "# hello", view: "preview", title: "P" });
    const token = await shellToken(server);
    const res = await fetch(`${server.url}/api/view/preview?session=${token}`);
```

- "the tool execute() path lands in the same registry and is served" — change the `/api/view/toolview` fetch:

```ts
    const out = await tool.execute("c1", { content: "**bold**", view: "toolviews" }, undefined, undefined, {});
    expect(out.details.url).toContain("/#toolviews");
    const token = await shellToken(server);
    const v = await (await fetch(`${server.url}/api/view/toolviews?session=${token}`)).json();
    expect(v.html).toContain("<strong>bold</strong>");
```

- "GET / serves the render shell after wiring" — extend the assertion to check the token is injected:

```ts
    const body = await (await fetch(`${server.url}/`)).text();
    expect(body).toContain("webui-render-shell");
    expect(body).toContain('const TOKEN = "');
```

- "render() returns the loopback URL composed from server.url" — **unchanged** (the tool result URL is `${server.url}/#z`, which carries no token; the user opens the base URL and the shell bootstraps itself).

- "GET /api/events SSE delivers a view_update on webui:render" — carry the token on the EventSource fetch:

```ts
    const token = await shellToken(server);
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events?session=${token}`, { signal: ctrl.signal });
```

- the decoupling test ("the render path does NOT call sendUserMessage …") — the WS open must carry the token; the render producer calls (events.emit / tool.execute) need no token (they go through the registry directly). Change the `openWs(...)` call:

```ts
    const token = await shellToken(server);
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws?session=${token}`), 2000, "ws open");
```

1d. In `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts`, add the same `shellToken` helper:

```ts
async function shellToken(server: WebServer): Promise<string> {
  const html = await (await fetch(`${server.url}/`)).text();
  const m = html.match(/const TOKEN = "([^"]+)";/);
  if (!m) throw new Error("TOKEN not found in served shell");
  return m[1];
}
```

and thread `?session=<token>` through every WS open in cases **B, C, D, F, F2** (cases E / E2 / A are unchanged: E/E2 test the origin guard which runs BEFORE the token check, so a non-loopback Origin is rejected regardless of token; A fetches `GET /` which is the token-exempt bootstrap). For each of B/C/D/F/F2, insert `const token = await shellToken(server);` right after `pi.emit("session_start", {}, pi.ctx());` and change the WS URL from `${server.url.replace("http", "ws")}/ws` to `${server.url.replace("http", "ws")}/ws?session=${token}`. Concretely, in each such test the two lines become, e.g. for case B:

```ts
    pi.emit("session_start", {}, pi.ctx());
    const token = await shellToken(server);
    const ws = await withTimeout(
      openWs(`${server.url.replace("http", "ws")}/ws?session=${token}`),
      2000,
      "ws open timed out"
    );
```

(Apply the identical `token` extraction + URL change to C, D, F, and F2. The announce test G from T4 does not open a WS — leave it.)

1e. In `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts`, give `FakeWebServer` a `setTokenAuth`. First extend the import to bring the type:

```ts
import { WebServer, type CommandHandler, type HttpRouteHandler } from "../src/web-server.js";
import type { TokenAuth } from "../src/token-auth.js";
```

then in `class FakeWebServer implements WebuiServer { … }` add a field + setter (next to `httpRoutes`):

```ts
  tokenAuth: TokenAuth | null = null;
```

```ts
  setTokenAuth(auth: TokenAuth | null): void {
    this.tokenAuth = auth;
  }
```

- [ ] **Step 2: Run the affected suites to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell.test.ts tests/render-routes.test.ts tests/render-integration.test.ts tests/wiring-live-smoke.test.ts tests/webui-wiring.test.ts )`
Expected: FAIL initially — `render-shell.test.ts`: `renderShellHtml`/`createRenderRoutes(registry, token)` do not exist yet; `render-integration`/`wiring-live-smoke`: `/api/*` + `/ws` now 403 (the wiring will set the gate once Step 3 lands) — but Step 3 lands the impl in the same task, so re-run after Step 3 to see green.

- [ ] **Step 3: Write minimal implementation**

3a. Rewrite `bun-apps/pi-agent-ext-webui/src/render-shell.ts` so it exports `renderShellHtml(token)` (the structure is identical to the prior `RENDER_SHELL_HTML`; only the wrapping function + the token/`?session=` additions differ):

```ts
/**
 * render-shell.ts — the vanilla browser shell (specs/06 D4/D5, specs/07 D4).
 *
 * A single inline HTML document (string, like web-access's generateCuratorPage):
 * no React, no Bun.build, no committed dist/. Served at GET / by
 * createRenderRoutes. RETIRES the ticket-04 connect-test stub (ticket 06 D8.3).
 *
 * Ticket 07 D4: the shell is generated with the per-session token baked in
 * (`const TOKEN="…"`) so the client authenticates every subsequent /api/* fetch
 * and the /ws upgrade with ?session=<token>. GET / itself is the token-exempt
 * bootstrap (the announced URL carries no token).
 *
 * Client behavior (D4):
 *   - on load: GET /api/views?session=TOKEN -> render tabs; select location.hash
 *     (or "main").
 *   - GET /api/view/:id?session=TOKEN -> md injects server-rendered html; html
 *     sets an <iframe sandbox=""> (no allow-scripts / allow-same-origin) srcdoc.
 *   - EventSource('/api/events?session=TOKEN') + WS …/ws?session=TOKEN -> on a
 *     view_update refresh tabs + re-render the affected view.
 */
export function renderShellHtml(token: string): string {
  return `<!-- webui-render-shell -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>webui render</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, system-ui, sans-serif; }
  header { display: flex; gap: .5rem; padding: .5rem; border-bottom: 1px solid #8884; flex-wrap: wrap; }
  .tab { padding: .35rem .7rem; border-radius: 6px; cursor: pointer; border: 1px solid transparent; background: #8882; }
  .tab.active { border-color: #6cf; background: #6cf3; }
  main { padding: 1rem; max-width: 1100px; margin: 0 auto; }
  .meta { color: #888; font-size: .8rem; margin-bottom: .5rem; }
  #content iframe { width: 100%; min-height: 70vh; border: 1px solid #8884; border-radius: 6px; background: #fff; }
  #content :is(pre,table) { background: #8881; padding: .5rem; border-radius: 4px; overflow:auto; }
  #content code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<header id="tabs"></header>
<main>
  <div class="meta" id="meta"></div>
  <div id="content"></div>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const SESSION_QS = "?session=" + encodeURIComponent(TOKEN);
const tabsEl = document.getElementById('tabs');
const metaEl = document.getElementById('meta');
const contentEl = document.getElementById('content');
let activeId = location.hash.slice(1) || 'main';

function fmtTime(ms) { try { return new Date(ms).toLocaleString(); } catch { return ''; } }

async function loadViews() {
  const res = await fetch('/api/views' + SESSION_QS);
  const views = res.ok ? await res.json() : [];
  tabsEl.innerHTML = '';
  for (const v of views) {
    const el = document.createElement('div');
    el.className = 'tab' + (v.id === activeId ? ' active' : '');
    el.dataset.viewId = v.id;
    el.textContent = v.title || v.id;
    el.title = v.id + ' · updated ' + fmtTime(v.updatedAt);
    el.onclick = () => { activeId = v.id; location.hash = v.id; renderView(v.id); };
    tabsEl.appendChild(el);
  }
  if (!views.some(v => v.id === activeId)) activeId = (views[0] && views[0].id) || 'main';
  return views;
}

async function renderView(id) {
  const res = await fetch('/api/view/' + encodeURIComponent(id) + SESSION_QS);
  if (!res.ok) { contentEl.innerHTML = '<p>no view</p>'; return; }
  const v = await res.json();
  document.querySelectorAll('.tab').forEach(function (t) {
    t.classList.toggle('active', t.dataset.viewId === id);
  });
  metaEl.textContent = (v.title ? (v.title + ' · ') : '') + 'mode ' + v.mode + ' · updated ' + fmtTime(v.updatedAt);
  if (v.mode === 'html') {
    contentEl.innerHTML = '';
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', ''); // D5: most restrictive — no scripts, no same-origin
    f.srcdoc = v.content;
    contentEl.appendChild(f);
  } else {
    contentEl.innerHTML = v.html || '';
  }
}

async function refresh() { await loadViews(); await renderView(activeId); }

function subscribe() {
  const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws' + SESSION_QS;
  const es = new EventSource('/api/events' + SESSION_QS);
  es.onmessage = async function (e) {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (data && data.viewId) { await loadViews(); if (data.viewId === activeId) await renderView(data.viewId); }
  };
  es.onerror = function () { es.close(); setTimeout(subscribe, 2000); };
}

(async function () { await refresh(); subscribe(); })();
</script>
</body>
</html>`;
}
```

3b. In `bun-apps/pi-agent-ext-webui/src/render-routes.ts`, change the import and the `GET /` branch. Replace the import:

```ts
import { RENDER_SHELL_HTML } from "./render-shell.js";
```

with:

```ts
import { renderShellHtml } from "./render-shell.js";
```

Change the factory signature and the `GET /` branch. Find:

```ts
export function createRenderRoutes(registry: RenderService): RenderRouteHandler {
  return (req) => {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/") {
      return new Response(RENDER_SHELL_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
```

and replace with:

```ts
export function createRenderRoutes(registry: RenderService, token: string): RenderRouteHandler {
  return (req) => {
    const url = new URL(req.url);
    const { pathname } = url;

    // GET / is the token-exempt bootstrap (WebServer.fetch skips the token check
    // for it); serve the shell with the token server-injected (specs/07 D4) so
    // the client can authenticate its subsequent /api/* + /ws calls.
    if (req.method === "GET" && pathname === "/") {
      return new Response(renderShellHtml(token), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
```

(Leave the `/api/views`, `/api/view/:id`, `/api/events`, fall-through branches unchanged.)

3c. In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, add `setTokenAuth` to the `WebuiServer` interface. Add the import near the top:

```ts
import type { TokenAuth } from "./token-auth.js";
import { createTokenAuth } from "./token-auth.js";
```

(Merge into one import line if preferred: `import { createTokenAuth, type TokenAuth } from "./token-auth.js";`.) Then in `export interface WebuiServer extends Broadcaster { … }`, add `setTokenAuth` next to `setHttpRoutes`:

```ts
  setHttpRoutes(handler: HttpRouteHandler | null): void;
  /** Inject the per-session token auth (ticket 07 D2). null = pass-through. */
  setTokenAuth(auth: TokenAuth | null): void;
  readonly url: string;
```

3d. Construct + enable the auth in `wireWebui`. Find the render-framework block (the `const registry = new RenderService({ … });` … `pi.events.on("webui:render", …);` lines) and insert the auth between the registry construction and `server.setHttpRoutes(...)`. The block becomes:

```ts
  const registry = new RenderService({
    urlFor: (id) => {
      try {
        return `${server.url}/#${id}`;
      } catch {
        return `#${id}`;
      }
    },
  });
  // --- ticket 07 auth (D1/D2/D4): one per-session token, enabled centrally on
  // the server AND baked into the served shell so the client self-authenticates.
  const auth = createTokenAuth();
  server.setTokenAuth(auth);
  server.setHttpRoutes(createRenderRoutes(registry, auth.token));
  pi.registerTool(createRenderTool(registry));
  pi.events.on("webui:render", createRenderEventHandler(registry));
```

3e. Clear the auth on dispose. In the `dispose()` method, immediately after the existing `server.setHttpRoutes(null);` add:

```ts
      server.setTokenAuth(null);
```

- [ ] **Step 4: Run the affected suites to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell.test.ts tests/render-routes.test.ts tests/render-integration.test.ts tests/wiring-live-smoke.test.ts tests/webui-wiring.test.ts )`
Expected: PASS — all cases green, including: `GET /` serves the shell with an injected `const TOKEN`; `/api/*` + `/ws` require `?session=<token>` (extracted from the shell) and 403 without; the announce still fires; `render()` returns the token-less base URL; the decoupling negative control still holds (no `sendUserMessage`, no chat frame on the render path).

- [ ] **Step 5: Run the FULL suite (the real conformance gate — tsconfig-tests gotcha)**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`
Expected: typecheck PASS (no output, exit 0); every test file green. Sanity spot-checks: `GET /` with no token → 200 (bootstrap exempt); `/api/views` with no token → 403; `/api/views?session=<token>` → 200; `/ws?session=<token>` → upgraded; announce `notify`/`setStatus` fire once at `session_start` with the resolved URL; `pi.execCalls === 0` (no auto-open); render/chat/mutex behavior unchanged (ticket 06 D8 still holds).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-shell.ts bun-apps/pi-agent-ext-webui/src/render-routes.ts bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/render-shell.test.ts bun-apps/pi-agent-ext-webui/tests/render-routes.test.ts bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts
git commit -m "feat(webui): enable session-token auth + server-injected shell token (ticket 07 D2/D4; suite green)"
```

---

## Notes for the implementer

- **T2 does NOT wire the gate; T5 does.** This is the one refinement of the ticket's suggested decomposition (see "Decomposition note"). Enabling the token gate before the shell-token injection (T5) would 403 every live integration test that cannot yet present the per-session `randomUUID`. Keep T2 to the `WebServer` mechanism + bare-server unit tests; enable in T5.
- **Async `fetch` is Bun-safe, including the WS upgrade.** T2 makes `WebServer.fetch` async so it can `await validateRequest`. Bun.serve keeps the request (and the `server.upgrade()` handshake) alive across the `await`; the T2 WS-upgrade cases (`?session=` → upgraded, no token → refused) and the T5 live WS tests prove the upgrade path still works. The hot path on a bare server (no `tokenAuth`) has no `await`, so existing origin-guard/stub-page tests are byte-for-byte unchanged in behavior.
- **`GET /` is the ONE token-exempt route (D3).** It is the bootstrap that delivers the server-injected token; every other route (`/api/*`, `/api/events`, `/ws`, `/health`) requires the token. The exemption is the one-liner `!(req.method === "GET" && url.pathname === "/")` in `WebServer.fetch` — reconcile "covers render routes + /health + /ws" (the DATA routes) with "announced URL is just the base URL" (which is only true if `GET /` loads without a token).
- **`ui` is on the session context, not the host.** `ExtensionAPI` has no `ui`; `ExtensionContext` does. T4 widens the wiring's **session-context** type (`WebuiSessionCtx`), leaving `WebuiHost` unchanged — and crucially adds **no `exec`** to the host, which is what makes "no auto-open" structurally enforced (the wiring cannot call `pi.exec` through the typed host).
- **The full `bun run typecheck && bun test` is the gate, every task.** `bun run typecheck` alone does NOT cover `tests/` (tsconfig `include` is `src/**/*.ts`). Every interface-widening task (T4, T5) updates the test fixtures (shared `MockPi` + every inline `MockPi`/ctx fake + `FakeWebServer`) **in the same task** and gates on the full suite.
- **Render decoupling (ticket 06 D8) still holds.** The auth/port/announce additions are strictly additive to the transport/wiring surface; they do not cause `sendUserMessage`, a `mutex_blocked`/chat frame, or any render→chat coupling. The T5 decoupling negative control (mirrors ticket 06's) guards this permanently.
- **`server.url` is read post-`start()`.** The announce and the registry `urlFor` both read `server.url` only after `server.start()` (at `session_start`); it reflects the resolved port (ephemeral or pinned). Neither reads it during `wireWebui` (the server starts on the first `session_start`, after `wireWebui` returns).
