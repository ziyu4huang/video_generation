# webui Port, Binding & URL Discovery (Ticket 07) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the merged webui transport (ticket 04) + render framework (ticket 06) a 3-tier port choice and a TUI-visible URL announcement — without coupling render to chat/mutex and without auto-opening a browser. **Auth = a simple, OPTIONAL token-based mechanism** on `WebServer` (`setTokenAuth(token: string | null)`; `null` ⇒ no check), **wired OFF for v1 loopback** (`null`) — loopback binding + the DNS-rebinding-safe `originAllowed` guard is the v1 boundary; the token is a cheap layer kept available for future non-loopback use.

**Architecture:** `WebServer` gains `setTokenAuth(token: string | null)` (a DI setter mirroring `setHttpRoutes`/`setCommandHandler`) + a central null-safe token check in `fetch` (after the origin guard, before `httpRoutes`; `?session=` for GET + WS-URL, `body.token` for POST, flat `!==`, 403; `null` ⇒ skip). A pure `resolvePort()` picks `WEBUI_PORT` > `PORT` > `0`; the lazy `WebServer` singleton binds it via `getServer()`. `wireWebui` wires `server.setTokenAuth(null)` (loopback ⇒ no check). At `session_start`, after `server.start()`, the wiring announces the resolved URL via the SDK `ctx.ui` surface (`notify` + `setStatus`) — widening the session-context type to reach `ctx.ui`, **no** `console.log`, **no** auto-open. **No shell-token injection, no `?session=` threading** in the render shell/routes; `RENDER_SHELL_HTML` stays a plain const (token is `null` for loopback, so no request needs `?session=`). The token channels exist only in the mechanism and are exercised by **unit tests**.

**Tech Stack:** `Bun.serve` (existing `WebServer`, `fetch` made `async` to read POST bodies), the SDK `ExtensionUIContext` (`ctx.ui.notify`/`setStatus`), TypeBox (unchanged), the existing vanilla render shell (unchanged). No new runtime deps.

## Global Constraints

Copied verbatim from the spec decisions (every task's requirements implicitly include these):

- **Loopback-only.** Binding stays `127.0.0.1` (ticket 04, unchanged). No remote/multi-user binding.
- **Auth = simple token-based, OPTIONAL via `setTokenAuth(token: string | null)`; `null` ⇒ no check.** `WebServer.fetch` runs the token check **after the origin guard and before `this.httpRoutes`**: if `this.token !== null`, extract the presented token (`?session=` URL param for GET + WS-URL; `body.token` JSON for POST, via `req.clone()` so a downstream route can still read the body) and compare flat `!==` (403 on mismatch); **if `this.token === null`, skip — no check**. **v1 loopback wires `null`** (`server.setTokenAuth(null)` in `wireWebui`) — loopback binding + the DNS-rebinding-safe `originAllowed` guard (checks `Origin` against `Host`, rejects non-loopback origins, allows absent-Origin for curl/scripts; runs in `WebServer.fetch` AND on the `/ws` upgrade) is the boundary. Channels `?session=` (GET + WS URL) / `body.token` (POST), flat `!==`, 403. **`RENDER_SHELL_HTML` stays a plain const** — NO shell-token injection, NO `?session=` threading in the render shell/routes (token is `null` for loopback, so no production request carries a token; the channels exist in the mechanism + are exercised by unit tests only).
- **Port 3-tier:** `WEBUI_PORT` env > `PORT` env > `0` (OS-assigned ephemeral). `serveWithFallback` already skips held ports (so `8090` / embed-mlx-server is avoided) — **no default to 8090**.
- **Announce via `ctx.ui` only:** at `session_start`, after `server.start()`, call `ctx.ui.notify("webui: <url>", "info")` + `ctx.ui.setStatus("webui", "<url>")`. **`console.log` is NOT acceptable** (it does not reach the TUI user — debugging only).
- **No auto-open:** the wiring never calls `pi.exec("open"/"xdg-open"/"cmd /c start")`. The host interface exposes **no `exec`** — announce-only is the v1 posture.
- **⚠️ tsconfig-tests gotcha (memory 3be99b98):** the package `tsconfig.json` `include` is `src/**/*.ts` only — `bun run typecheck` does NOT typecheck `tests/`. Every task that widens an interface a test implements MUST update the test fixtures (the shared `MockPi` helper AND every inline `MockPi`/ctx fake AND `FakeWebServer`) in the SAME task, and the conformance gate is the FULL `bun run typecheck && bun test` (never typecheck alone).

**Revision note (final scope).** The merged PR #1245 plan carried five tasks including a mandatory `TokenAuth` + `setTokenAuth` + server-injected shell token. An earlier revision of this plan **dropped** token auth entirely. The **final** design is a middle path: a **simple, optional token-based auth** IS implemented on `WebServer` (`setTokenAuth(token: string | null)`, `null` ⇒ no check), but **wired OFF for v1 loopback** (`null`). The server-injected shell token (`renderShellHtml(token)`, `?session=` threading in the shell/routes) stays **dropped**. The revised plan is **four TDD tasks**: token-auth mechanism · port resolution (3-tier) · announce via `ctx.ui` · integration. It touches `web-server.ts` (the `setTokenAuth` mechanism + null-safe `fetch` block), `webui-wiring.ts` (`WebuiServer` gains `setTokenAuth`; `getServer()` uses `resolvePort()`; `wireWebui` wires `setTokenAuth(null)` + the announce), and `tests/`. It does NOT touch `src/render-shell.ts` or `src/render-routes.ts` (the shell + routes stay as ticket 06 left them; `RENDER_SHELL_HTML` is a const). This supersedes the earlier "drop auth entirely" revision.

## File Structure

**Create (all under `bun-apps/pi-agent-ext-webui/`):**
- `src/port-resolver.ts` — pure `resolvePort(env?)` 3-tier resolver. Single responsibility: pick the requested port.
- `tests/port-resolver.test.ts` — one test file for the pure module.
- `tests/web-server-token-auth.test.ts` — token mechanism unit tests (the `setTokenAuth` null-safe check).

**Modify:**
- `src/web-server.ts` (T1) — `token` field + `setTokenAuth` setter + null-safe token block in `fetch` (after origin guard, before `httpRoutes`); `fetch` becomes `async`.
- `src/webui-wiring.ts` (T1, T2, T3) — T1: `WebuiServer` interface gains `setTokenAuth`; T2: `getServer()` uses `resolvePort()` instead of the hardcoded `port: 0`; T3: add `WebuiUi`/`WebuiSessionCtx`, widen the `session_start` handler to announce.
- `tests/webui-wiring.test.ts` (T1, T3) — T1: `FakeWebServer` gains a `setTokenAuth` stub (records the call; default `null`); T3: add an announce unit test.
- `tests/helpers/mock-pi.ts` (T3) — `MockPi.ctx` gains a `ui` stub recording `notify`/`setStatus`.
- `tests/wiring-live-smoke.test.ts` (T3, T4) — T3: inline `MockPi.ctx()` `ui` + `exec` recorder + announce test G; T4: resolved-URL integration + null-token pass-through assertions.
- `tests/render-integration.test.ts` (T3) — inline `MockPi.ctx()` `ui` stub (needed because its tests call `session_start`).
- `tests/webui-wiring.test.ts` (T3) — add an announce unit test (already listed above; touched in both T1 and T3 — non-overlapping regions).

**No change** to:
- `src/render-shell.ts` — `RENDER_SHELL_HTML` stays a plain const (no token injection).
- `src/render-routes.ts` — `createRenderRoutes(registry)` signature is unchanged (no token arg); all routes are GET.
- `extensions/webui.ts` — the cast `pi as unknown as WebuiHost` still holds; `ui` is on ctx, not the host.

---

### Task 1: WebServer token-auth mechanism (optional, `null` ⇒ no check)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/web-server.ts` (add `token` field + `setTokenAuth` setter + a module-level `readPresentedToken` helper + null-safe token block in `fetch`; `fetch` becomes `async`)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (`WebuiServer` interface gains `setTokenAuth(token: string | null): void`)
- Modify: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` (`FakeWebServer` gains a `setTokenAuth` stub so it satisfies the widened `WebuiServer`)
- Test: `bun-apps/pi-agent-ext-webui/tests/web-server-token-auth.test.ts`

**Interfaces:**
- Consumes: the existing `WebServer.fetch` origin guard (first chokepoint, **unchanged**) + the `this.httpRoutes` seam (additive routes); standard `Request`/`URL` (`?session=` URL param) + `req.clone().json()` for POST `body.token`.
- Produces:
  - `WebServer.setTokenAuth(token: string | null): void` — DI setter mirroring `setHttpRoutes`/`setCommandHandler`.
  - `private token: string | null = null` field.
  - **Behavior contract (spec D1):** in `fetch`, **after the origin guard and before `this.httpRoutes`**, if `this.token !== null`, the presented token is extracted (`?session=` URL param for GET + the WS upgrade; `body.token` JSON for POST, read via `req.clone()` so a downstream additive route can still read the body) and compared flat `!==` (403 `"Forbidden"` on mismatch). **If `this.token === null`, the block is skipped** — requests pass with only the origin guard. The origin guard stays the first chokepoint. `fetch` becomes `async` (POST body read is awaited); Bun.serve accepts a `Promise<Response>` from `fetch`.
  - `WebuiServer.setTokenAuth(token: string | null): void` added to the wiring's server interface.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/web-server-token-auth.test.ts`:

```ts
/**
 * web-server-token-auth.test.ts — ticket 07 D1: the OPTIONAL token-auth
 * mechanism on WebServer. null => no check (v1 loopback); non-null => every
 * request must present the token (?session= for GET + WS-URL; body.token for
 * POST), flat !==, 403 on mismatch. The origin guard runs FIRST regardless.
 *
 * All servers bind port 0 (ephemeral); every started server is stopped in
 * afterEach. Real HTTP via the global fetch() (same pattern as the origin-guard
 * tests in web-server.test.ts). The origin-guard 403 body is "forbidden"
 * (lowercase); the token-block 403 body is "Forbidden" (capital F) — tests
 * assert the body to confirm WHICH check fired (proves ordering).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";

const started: WebServer[] = [];
function makeServer(): WebServer {
  const s = new WebServer({ port: 0 });
  started.push(s);
  return s;
}
afterEach(() => {
  while (started.length) {
    const s = started.pop()!;
    try {
      s.stop();
    } catch {
      /* ignore */
    }
  }
});

describe("WebServer token auth (setTokenAuth, ticket 07 D1)", () => {
  it("default (never set) => token null => GET passes WITHOUT ?session=", async () => {
    const s = makeServer();
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("explicit setTokenAuth(null) => GET passes WITHOUT ?session=", async () => {
    const s = makeServer();
    s.setTokenAuth(null);
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
  });

  it("non-null token + valid ?session= => passes", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health?session=secret`);
    expect(res.status).toBe(200);
  });

  it("non-null token + MISSING ?session= => 403", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(403);
  });

  it("non-null token + WRONG ?session= => 403", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health?session=nope`);
    expect(res.status).toBe(403);
  });

  it("non-null token + valid body.token (POST) => passes", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health`, {
      method: "POST",
      body: JSON.stringify({ token: "secret" }),
    });
    expect(res.status).toBe(200);
  });

  it("non-null token + POST WITHOUT body.token => 403", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health`, {
      method: "POST",
      body: JSON.stringify({ other: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("origin guard runs FIRST: hostile Origin + valid ?session= => still 403 (origin)", async () => {
    // A valid token does NOT rescue a hostile origin => proves the origin guard
    // is checked before the token block. Body "forbidden" (lowercase) = origin.
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health?session=secret`, {
      headers: { Origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden");
  });

  it("token-block 403 body is 'Forbidden' (distinct from the origin 'forbidden')", async () => {
    const s = makeServer();
    s.setTokenAuth("secret");
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-server-token-auth.test.ts )`
Expected: FAIL — `WebServer` has no `setTokenAuth` method (`s.setTokenAuth is not a function`); the default-null cases pass incidentally (no check yet), but every non-null case fails (no enforcement).

- [ ] **Step 3: Write minimal implementation**

3a. In `bun-apps/pi-agent-ext-webui/src/web-server.ts`, add a module-level helper immediately AFTER the `originAllowed(...)` function (before `export interface SessionRef`):

```ts
/**
 * Read the presented auth token for the OPTIONAL token check (ticket 07 D1).
 * GET + WS-URL: the ?session= query param; POST: body.token (JSON, read via
 * clone() so a downstream additive route can still read the body). Returns null
 * when absent / unparseable. Only called when this.token !== null.
 */
async function readPresentedToken(req: Request, url: URL): Promise<string | null> {
  if (req.method === "POST") {
    try {
      const body = await req.clone().json();
      return typeof body?.token === "string" ? body.token : null;
    } catch {
      return null;
    }
  }
  return url.searchParams.get("session");
}
```

3b. Add the `token` field. Find the field declarations near the top of the `WebServer` class:

```ts
  private onCommand: CommandHandler | null = null;
  private httpRoutes: HttpRouteHandler | null = null;
```

and replace with:

```ts
  private onCommand: CommandHandler | null = null;
  private httpRoutes: HttpRouteHandler | null = null;
  /** Optional token-auth token (ticket 07 D1); null => NO check (v1 loopback). */
  private token: string | null = null;
```

3c. Add the `setTokenAuth` setter. Find the existing `setHttpRoutes` method:

```ts
  setHttpRoutes(handler: HttpRouteHandler | null): void {
    this.httpRoutes = handler;
  }
```

and replace with:

```ts
  setHttpRoutes(handler: HttpRouteHandler | null): void {
    this.httpRoutes = handler;
  }

  /**
   * Set the OPTIONAL token-auth token (ticket 07 D1). `null` (the default / the
   * v1 loopback wiring) => NO token check — requests pass with only the origin
   * guard. A non-null token requires every request to present it via `?session=`
   * (GET + WS-URL) / `body.token` (POST). Mirrors setHttpRoutes/setCommandHandler.
   */
  setTokenAuth(token: string | null): void {
    this.token = token;
  }
```

3d. Insert the null-safe token block in `fetch` AND make `fetch` async. Find the `fetch` method header + origin guard:

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
    // upgrade (the /ws branch below). Absent Origin is allowed. This is the
    // FIRST chokepoint and stays first.
    const origin = req.headers.get("origin");
    if (origin && !originAllowed(origin, req.headers.get("host"))) {
      return new Response("forbidden", { status: 403 });
    }
    // Optional token auth (ticket 07 D1): null => NO check. Runs AFTER the
    // origin guard and BEFORE this.httpRoutes. ?session= for GET + the WS-URL;
    // body.token (JSON, via clone()) for POST. Flat !==, 403 on mismatch.
    if (this.token !== null) {
      const presented = await readPresentedToken(req, url);
      if (presented !== this.token) return new Response("Forbidden", { status: 403 });
    }
    if (this.httpRoutes) {
```

(The rest of `fetch` — the `/health`, `/`, `/ws`, 404 branches — is unchanged. The `fetch: (req, srv) => this.fetch(req, srv)` arrow inside `serveWithFallback` already returns whatever `fetch` returns; Bun.serve accepts `Response | Promise<Response>`, so making `fetch` async needs no change there.)

3e. Widen the `WebuiServer` interface in `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`. Find:

```ts
  setCommandHandler(cb: CommandHandler | null): void;
  setHttpRoutes(handler: HttpRouteHandler | null): void;
```

and replace with:

```ts
  setCommandHandler(cb: CommandHandler | null): void;
  setHttpRoutes(handler: HttpRouteHandler | null): void;
  /** OPTIONAL token auth (ticket 07 D1); null => no check (v1 loopback). */
  setTokenAuth(token: string | null): void;
```

3f. Update `FakeWebServer` in `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts`. Find the field declarations:

```ts
  commandHandler: CommandHandler | null = null;
  httpRoutes: HttpRouteHandler | null = null;
```

and replace with:

```ts
  commandHandler: CommandHandler | null = null;
  httpRoutes: HttpRouteHandler | null = null;
  /** Recorded token-auth call (ticket 07 D1); default null (loopback off). */
  tokenAuth: string | null = null;
```

Then find the `setHttpRoutes` method on `FakeWebServer`:

```ts
  setHttpRoutes(handler: HttpRouteHandler | null): void {
    this.httpRoutes = handler;
  }
```

and replace with:

```ts
  setHttpRoutes(handler: HttpRouteHandler | null): void {
    this.httpRoutes = handler;
  }
  setTokenAuth(token: string | null): void {
    this.tokenAuth = token;
  }
```

- [ ] **Step 4: Run the token-auth test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-server-token-auth.test.ts )`
Expected: PASS — all 9 cases green (null ⇒ no check; non-null ⇒ `?session=`/`body.token` enforced; origin guard first).

- [ ] **Step 5: Run the FULL suite (the real conformance gate — tsconfig-tests gotcha)**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`
Expected: typecheck PASS; every test file green. `WebuiServer` widened ⇒ `FakeWebServer` (updated in 3f) satisfies it; the live `WebServer` (updated in 3b/3c) satisfies it. `web-server.test.ts` still green — `fetch` is now async but every call already `await`s the response.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/web-server.ts bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts bun-apps/pi-agent-ext-webui/tests/web-server-token-auth.test.ts
git commit -m "feat(webui): WebServer optional token-auth mechanism (setTokenAuth null => no check) (ticket 07 D1)"
```

---

### Task 2: Port resolution (3-tier `resolvePort`)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/port-resolver.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (`getServer()` uses `resolvePort()` instead of the hardcoded `port: 0`)
- Test: `bun-apps/pi-agent-ext-webui/tests/port-resolver.test.ts`

**Interfaces:**
- Consumes: nothing (pure; takes an injectable env so tests are deterministic — no `process.env` mutation).
- Produces:
  - `export function resolvePort(env?: Record<string, string | undefined>): number` — `WEBUI_PORT` > `PORT` > `0`. Invalid (non-integer / out of `[1,65535]` / empty) falls through to the next tier, ultimately `0`. Default env source: `process.env`.
  - **Behavior contract (spec D2):** `serveWithFallback` (web-server.ts) already walks `port..port+50` on `EADDRINUSE`, so held ports — notably `8090` (embed-mlx-server LaunchAgent) — are inherently avoided. There is **no default to 8090**. The singleton constructor is changed from `port: 0` to `port: resolvePort()`; `resolvePort()` is called lazily (first `getServer()`), so test runs with neither env var set still get an ephemeral port. The announce (T3) reads `server.url` after `start()`, which reflects this resolved port.

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
 * port-resolver.ts — 3-tier port selection (specs/07 D2).
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

(T4 separately wires `server.setTokenAuth(null)` in `wireWebui`; T2 touches only `getServer()`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/port-resolver.test.ts )`
Expected: PASS — all 11 cases green.

- [ ] **Step 6: Run the wiring suite to confirm no regression**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: PASS. The singleton-identity test calls `wireWebui(pi)` with no injected server → `getServer()` → `resolvePort()` (no env in the runner) → `0` → ephemeral. (`FakeWebServer` is injected elsewhere; the singleton path still resolves to ephemeral.)

- [ ] **Step 7: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/port-resolver.ts bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/port-resolver.test.ts
git commit -m "feat(webui): add resolvePort 3-tier port resolver + wire into singleton (ticket 07 D2)"
```

---

### Task 3: Announce via `ctx.ui` at `session_start` (no auto-open)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (add `WebuiUi`/`WebuiSessionCtx`; widen the `session_start` handler to announce)
- Modify: `bun-apps/pi-agent-ext-webui/tests/helpers/mock-pi.ts` (`MockPi.ctx` gains a `ui` stub recording `notify`/`setStatus`)
- Modify: `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts` (inline `MockPi.ctx()` `ui` + `exec` recorder; add announce test G)
- Modify: `bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts` (inline `MockPi.ctx()` `ui` stub — needed because its tests call `session_start`)
- Test: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` (add an announce unit test)

**Interfaces:**
- Consumes: the SDK `ExtensionContext.ui: ExtensionUIContext` — verified `notify(message: string, type?: "info"|"warning"|"error"): void` and `setStatus(key: string, text: string | undefined): void` (`dist/core/extensions/types.d.ts`). The `WebuiServer.url` getter (throws before `start()`, valid after — read post-`start()`).
- Produces:
  - `export interface WebuiUi { notify(message: string, type?: "info" | "warning" | "error"): void; setStatus(key: string, text: string | undefined): void }` — the mockable announce surface (in `webui-wiring.ts`).
  - `export interface WebuiSessionCtx { abort(): void; ui: WebuiUi }` — the widened session-context type. This **undoes** the prior `ctx as { abort(): void }` downcast so the handler can reach `ctx.ui`. (`ui` lives on the **session context**, the 2nd arg to `session_start` — NOT on the host; `ExtensionAPI` has no `ui`. The host interface `WebuiHost` is unchanged — it gains no `exec`, which is what makes "no auto-open" structurally enforced.)
  - **Behavior contract (spec D3/D4):** at `session_start`, after `server.start()` + `bindSession`, the handler reads `server.url` (resolved — see T2) and calls `sessionCtx.ui.notify(\`webui: ${url}\`, "info")` + `sessionCtx.ui.setStatus("webui", url)`. No `console.log`; no `pi.exec` (no auto-open).

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
Expected: FAIL — `webui-wiring.test.ts`: `pi.ctx.notifications` is undefined (MockPi.ctx has no `ui` yet) → the session_start handler throws reaching `ctx.ui`. `wiring-live-smoke.test.ts`: `pi.uiNotifications` is undefined / handler throws on `ctx.ui`.

- [ ] **Step 3: Write minimal implementation**

3a. In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, add the two interfaces immediately after the existing `RenderHostEvents` interface:

```ts
/**
 * The TUI UI surface the announce uses (ticket 07 D3/D4). Mirrors exactly the
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
 * so session_start can reach ctx.ui (specs/07 D3).
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
    // ticket 07 announce (specs/07 D3): surface the RESOLVED URL to the TUI user
    // via the SDK ui surface (notify + setStatus). NO console.log (it does not
    // reach the TUI user — debugging only); NO auto-open (the host exposes no
    // exec). server.url is read AFTER start(), so it reflects the bound port
    // (ephemeral or pinned — resolved via resolvePort in T2). start() is
    // idempotent + the singleton persists, so re-announces on
    // reload/new/resume/fork show the same stable URL.
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
git commit -m "feat(webui): announce resolved URL via ctx.ui at session_start (no auto-open) (ticket 07 D3/D4)"
```

---

### Task 4: Integration + suite-green (wire `setTokenAuth(null)` + port + announce)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (`wireWebui` wires `server.setTokenAuth(null)` — loopback, no check — right after resolving the server handle)
- Modify: `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts` (add a resolved-URL integration assertion + a null-token pass-through assertion that tie T1's token mechanism + T2's port resolution + T3's announce through a live `wireWebui`; add a static import of `resolvePort`)
- No other `src/` changes — T1 added the mechanism; T2 wired `resolvePort()` into `getServer()`; T3 added the announce. T4 wires the token OFF + verifies the three compose end-to-end and the whole package is green.

**Interfaces:**
- Consumes: `WebuiServer.setTokenAuth` (T1); `resolvePort` from `./port-resolver.js` (T2, pure — for a deterministic 3-tier assertion in the integration suite); the live `WebuiServer.url` (resolved post-`start()`); the `ctx.ui` announce surface from T3.
- Produces: nothing exported. The deliverable is the loopback wiring call + an integration test + a green full-suite gate.
- **Behavior contract (spec D1+D2+D3 composed):** `wireWebui` calls `server.setTokenAuth(null)` (loopback ⇒ token OFF — no request needs `?session=`). The announce and the port resolution compose — after `session_start`, the announced URL (from `ctx.ui.notify`/`setStatus`) is the **live resolved** `http://127.0.0.1:<port>` (port > 0, host `127.0.0.1` — not the literal `0`), exactly equal to `server.url`. With the token `null`, `GET /`, `/api/*`, `/api/events`, and the `/ws` upgrade all pass **WITHOUT `?session=`**. The pure `resolvePort` 3-tier ordering (`WEBUI_PORT` > `PORT` > `0`) is proven deterministically by T2's unit tests, which are part of the full-suite gate below. **No shell-token injection** anywhere: `RENDER_SHELL_HTML` is a const, no `?session=` threading in the shell/routes.

- [ ] **Step 1: Wire the token OFF for loopback.** In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, find the top of `wireWebui`:

```ts
  const server = deps.server ?? getServer();
  const broadcaster: Broadcaster = deps.broadcaster ?? server;
```

and replace with:

```ts
  const server = deps.server ?? getServer();
  // ticket 07 D1: loopback wiring — token OFF (null => no check). Loopback
  // binding + the DNS-rebinding-safe originAllowed guard is the v1 boundary;
  // the token mechanism stays AVAILABLE but OFF (a future non-loopback deployer
  // sets a non-null token). No shell-token injection: RENDER_SHELL_HTML is a
  // const and no request carries ?session=.
  server.setTokenAuth(null);
  const broadcaster: Broadcaster = deps.broadcaster ?? server;
```

- [ ] **Step 2: Write the integration test**

In `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts`, first add a static import of `resolvePort` next to the existing `../src/...` imports (ESM, matching the file's style — no `require`):

```ts
import { resolvePort } from "../src/port-resolver.js";
```

Then add three Tier-A integration cases after test G (inside `describe("wireWebui live smoke — Tier A", ...)`):

```ts
  it("H) announce + port resolution compose: the announced URL is the live resolved loopback URL", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // The announced URL EQUALS server.url (T3 reads server.url after start()).
    expect(pi.uiNotifications[0]?.message).toBe(`webui: ${server.url}`);
    expect(pi.uiStatuses[0]?.text).toBe(server.url);
    // server.url is the LIVE resolved URL — a real loopback address with a real
    // (non-zero) port produced by resolvePort via getServer() (T2). Not literal 0.
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);
    expect(new URL(server.url).port).not.toBe("0");
  });

  it("I) v1 wires null token => /, /api/views, /api/events all pass WITHOUT ?session=", async () => {
    // wireWebui calls server.setTokenAuth(null) (T4). With the token null the
    // fetch token block is skipped, so NO request needs ?session=. Proves the
    // loopback wiring is "off" end-to-end against a live server.
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const root = await fetch(`${server.url}/`);
    expect(root.status).toBe(200);
    const views = await fetch(`${server.url}/api/views`);
    expect(views.status).toBe(200);
    const events = await fetch(`${server.url}/api/events`);
    // /api/events is an SSE stream — the origin guard + null-token skip let it
    // through (200); we only assert it is reachable (not 403/404).
    expect(events.status).toBe(200);
  });

  it("J) v1 wires null token => /ws upgrade succeeds WITHOUT ?session=", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(
      openWs(`${server.url.replace("http", "ws")}/ws`),
      2000,
      "ws open timed out"
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("K) resolvePort 3-tier is honored (WEBUI_PORT > PORT > 0) — pure, integration-recorded", () => {
    // The pure resolver is unit-tested in port-resolver.test.ts (T2); this case
    // records the ordering in the live integration suite. resolvePort is the
    // function getServer() calls (T2 wiring).
    expect(resolvePort({ WEBUI_PORT: "8080", PORT: "9000" })).toBe(8080);
    expect(resolvePort({ PORT: "9000" })).toBe(9000);
    expect(resolvePort({})).toBe(0);
  });
```

(Note: test K is a thin re-statement of T2's pure ordering inside the live suite; the authoritative 3-tier proof is `tests/port-resolver.test.ts`. It is included so the integration task's gate explicitly covers "port 3-tier resolves `WEBUI_PORT` > `PORT` > `0`" without depending on `process.env` mutation against the lazy singleton.)

- [ ] **Step 3: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/wiring-live-smoke.test.ts )`
Expected: PASS — T1+T2+T3 already landed the mechanism + port resolution + announce, and T4 wired `setTokenAuth(null)`. H asserts the announce URL equals the live `server.url` (resolved, port > 0); I+J assert the null-token pass-through (`/`, `/api/views`, `/api/events`, `/ws` all reachable WITHOUT `?session=`); K re-asserts the pure 3-tier ordering.

- [ ] **Step 4: Run the FULL suite (the real conformance gate — tsconfig-tests gotcha)**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`
Expected: typecheck PASS (no output, exit 0); every test file green. Sanity spot-checks: `session_start` announces once via `ctx.ui.notify` + `setStatus` with the resolved `server.url`; `server.url` is `http://127.0.0.1:<port>` (port > 0); `pi.execCalls === 0` (no auto-open); `resolvePort` 3-tier (`WEBUI_PORT` > `PORT` > `0`) green; token mechanism (`setTokenAuth`) green (null ⇒ no check; non-null ⇒ enforced); with `null` wired, `/api/*` + `/ws` + `/` pass WITHOUT `?session=`; render/chat/mutex behavior unchanged (ticket 06 D8 still holds).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts
git commit -m "feat(webui): wire setTokenAuth(null) loopback + integration (announce/port/token compose, suite green) (ticket 07 D1+D2+D3)"
```

---

## Notes for the implementer

- **Auth = optional token, OFF for loopback.** `WebServer.setTokenAuth(token: string | null)` is a DI setter (mirrors `setHttpRoutes`/`setCommandHandler`); the null-safe check runs in `fetch` AFTER the origin guard and BEFORE `httpRoutes` (`?session=` GET+WS / `body.token` POST, flat `!==`, 403; `null` ⇒ skip). **v1 loopback wires `null`** (`wireWebui` → `server.setTokenAuth(null)`) — loopback binding + the DNS-rebinding-safe `originAllowed` guard is the boundary. The token channels exist in the mechanism + are exercised by UNIT TESTS only. **No shell-token injection**: `RENDER_SHELL_HTML` stays a const, `render-routes.ts` is unchanged (all GET), no `?session=` threading anywhere in the shell/routes.
- **`fetch` becomes async.** Only the POST `body.token` path awaits (`req.clone().json()`). Bun.serve accepts `Promise<Response>`; the existing tests already `await` responses, so no behavior change. `clone()` tees the body so a future POST route (none today — render-routes is all GET) could still read it.
- **`ui` is on the session context, not the host.** `ExtensionAPI` has no `ui`; `ExtensionContext` does. T3 widens the wiring's **session-context** type (`WebuiSessionCtx`), leaving `WebuiHost` unchanged — and crucially adds **no `exec`** to the host, which is what makes "no auto-open" structurally enforced (the wiring cannot call `pi.exec` through the typed host).
- **The full `bun run typecheck && bun test` is the gate, every task.** `bun run typecheck` alone does NOT cover `tests/` (tsconfig `include` is `src/**/*.ts`). T1 widens `WebuiServer` → updates `FakeWebServer` in-task. T3 widens `WebuiSessionCtx` → updates the shared `MockPi` + every inline `MockPi`/ctx fake in-task. T2 and T4 do not widen a test-implemented interface, but still run the full gate.
- **Render decoupling (ticket 06 D8) still holds.** The token/port/announce additions are strictly additive to the transport/wiring surface; they do not cause `sendUserMessage`, a `mutex_blocked`/chat frame, or any render→chat coupling. The shell + routes are untouched (`RENDER_SHELL_HTML` is a const).
- **`server.url` is read post-`start()`.** The announce (T3) and the registry `urlFor` both read `server.url` only after `server.start()` (at `session_start`); it reflects the resolved port (ephemeral or pinned, via `resolvePort` in T2). Neither reads it during `wireWebui` (the server starts on the first `session_start`, after `wireWebui` returns).
- **T4 is wire + test + gate.** T1 adds the mechanism; T2 wires `resolvePort()` into `getServer()`; T3 wires the announce into `session_start`. T4 adds the single `server.setTokenAuth(null)` wiring call + the cross-cutting integration assertions (token OFF ⇒ `/`+`/api/*`+`/ws` pass without `?session=`; announce URL == live resolved `server.url`; port > 0) and runs the whole-package gate. If T1/T2/T3 landed green, T4's tests pass immediately and the suite is green.
