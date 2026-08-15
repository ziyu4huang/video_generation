# webui Generic Render Framework (Ticket 06) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic, decoupled render framework to `pi-agent-ext-webui` so any producer (tool or extension event) can push markdown/HTML into named browser views that update live over SSE, served on the existing loopback `WebServer` with no build step and no coupling to the chat/mutex transport.

**Architecture:** An in-memory `RenderService` registry holds named views (`md`/`html`). Producers reach it two ways: a `webui_render` tool (LLM/skill path) and a `pi.events` `"webui:render"` channel (extension path). The existing `WebServer` gains a `setHttpRoutes(handler)` DI setter so a `createRenderRoutes(registry)` module can register additive HTTP routes (`GET /api/views`, `GET /api/view/:id`, `GET /api/events` SSE, `GET /` shell) **before** the hardcoded `/health`,`/`,`/ws` branches — touching none of the chat/mutex code. Markdown is rendered server-side by `marked`; HTML is shown in a sandboxed `<iframe>`.

**Tech Stack:** TypeBox (`typebox`), `marked@^15` (server-side md→html), `Bun.serve` (existing `WebServer`), Server-Sent Events (`text/event-stream`), a single vanilla-JS HTML shell string — no React, no `Bun.build`, no committed `dist/`.

## Global Constraints

Copied verbatim from the spec decisions (every task's requirements implicitly include these):

- **D5 — HTML trust boundary:** `html` mode renders inside `<iframe sandbox="">` (no `allow-scripts`, no `allow-same-origin`) via `srcdoc`. No `DOMPurify` dependency.
- **D6 — Dependency:** Add `marked` (`^15`) to `@repo/pi-agent-ext-webui` deps, server-side only. No sanitizer dep.
- **D7 — URL & port:** Served on the `WebServer`'s existing ephemeral loopback port (`server.url`); `render()` returns `${server.url}/#${viewId}`. Announcing the URL at `session_start` is **out of scope** (deferred to ticket 07).
- **D8 — Decoupling invariants (must hold):** (1) the render framework does **not** touch `pi.on("input")`, the mutex, `sendUserMessage`, or the `/ws` chat frames; (2) it is strictly additive — new routes (via `setHttpRoutes`), a new SSE channel, a new registry, a new tool, a new `pi.events` subscription; (3) the only existing ticket-04 behavior changed is `GET /` (stub connect-test → render shell); `/health` and `/ws` are unchanged. All routes remain loopback-only via the existing `originAllowed` guard.
- Loopback-only: every new route inherits the existing `originAllowed` Host-header guard (consulted before any route handler).
- No build step, no committed artifacts: the browser shell is an inline string constant (like `web-access`'s `generateCuratorPage`), not a `dist/` file.

## File Structure

**Create (all under `bun-apps/pi-agent-ext-webui/`):**
- `src/render-service.ts` — pure in-memory `RenderService` registry (`render`/`listViews`/`getView`/`subscribe`). Owns view storage + change-notification. Single responsibility: the registry.
- `src/render-markdown.ts` — pure `renderMarkdown(md): string` wrapper over `marked`. Single responsibility: md→html.
- `src/render-routes.ts` — `createRenderRoutes(registry): RenderRouteHandler` implementing the additive HTTP routes (`GET /api/views`, `GET /api/view/:id`, `GET /api/events` SSE, `GET /` shell). Single responsibility: HTTP adapter over the registry.
- `src/render-shell.ts` — `RENDER_SHELL_HTML` string constant (vanilla JS browser shell). Single responsibility: the client UI markup.
- `src/render-tool.ts` — `createRenderTool(registry): ToolDefinition` (the `webui_render` tool). Single responsibility: tool adapter over the registry.
- `src/render-event-handler.ts` — `createRenderEventHandler(registry): RenderEventHandler` (validates + dispatches a `"webui:render"` event payload into the registry). Single responsibility: event-channel adapter over the registry.
- `tests/render-service.test.ts`, `tests/render-markdown.test.ts`, `tests/render-routes.test.ts`, `tests/render-shell.test.ts`, `tests/render-tool.test.ts`, `tests/render-event-handler.test.ts`, `tests/render-integration.test.ts` — one test file per task.

**Modify:**
- `src/web-server.ts` (T2) — add `HttpRouteHandler` type, `httpRoutes` field, `setHttpRoutes` setter, and consult the handler inside `fetch`.
- `src/webui-wiring.ts` (T2 + T8) — T2: add `setHttpRoutes` to the `WebuiServer` interface; T8: widen `WebuiHost` with `events` + `registerTool`, construct the registry, wire routes/tool/event.
- `tests/web-server.test.ts` (T2) — add `setHttpRoutes` tests.
- `tests/wiring-live-smoke.test.ts` (T8) — update `MockPi` for the widened host + update assertion A (`GET /` now serves the shell).
- `package.json` (T3) — add `marked@^15` dependency.

---

### Task 1: Render registry (pure `RenderService`)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/render-service.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/render-service.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no I/O, no `bun`, no `pi`).
- Produces (the shared types/methods every later task imports from `./render-service.js`):
  - `export type RenderMode = "md" | "html"`
  - `export interface RenderView { id: string; mode: RenderMode; content: string; title?: string; updatedAt: number }`
  - `export interface RenderInput { content: string; mode?: RenderMode; view?: string; title?: string }`
  - `export interface RenderResult { viewId: string; url: string }`
  - `export type RenderListener = (viewId: string, updatedAt: number) => void`
  - `export interface RenderServiceOptions { urlFor?: (viewId: string) => string; now?: () => number }`
  - `export class RenderService` with:
    - `constructor(opts?: RenderServiceOptions)`
    - `render(input: RenderInput): RenderResult` — replace semantics; default view `"main"`, default mode `"md"`; `updatedAt` advances on each render; notifies all subscribers after the view is stored.
    - `listViews(): RenderView[]` — snapshot of every stored view.
    - `getView(id: string): RenderView | undefined`
    - `subscribe(listener: RenderListener): () => void` — returns an unsubscribe; subscriber set is used by the SSE route (T4) and asserted in tests.
    - `get subscriberCount(): number`
  - `urlFor` design note (documented here so later tasks compose URLs correctly): the registry does **not** know the server port. It accepts a `urlFor(viewId)` callback at construction; `render()` calls it to produce `RenderResult.url`. The default is `(id) => "#" + id`. T8 constructs the registry with `urlFor: (id) => server.url + "/#" + id` — `server.url` is read lazily at `render()` time (the server starts on `session_start`, after `wireWebui` returns).

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/render-service.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { RenderService } from "../src/render-service.js";

describe("RenderService", () => {
  it("render() creates the default view 'main' with mode 'md'", () => {
    const r = new RenderService({ urlFor: (id) => `http://x/#${id}`, now: () => 100 });
    const out = r.render({ content: "# hi" });
    expect(out).toEqual({ viewId: "main", url: "http://x/#main" });
    expect(r.getView("main")).toMatchObject({
      id: "main",
      mode: "md",
      content: "# hi",
      updatedAt: 100,
    });
  });

  it("render() accepts an explicit view/mode/title", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 100 });
    r.render({ content: "<p>x</p>", mode: "html", view: "preview", title: "Preview" });
    expect(r.getView("preview")).toMatchObject({
      id: "preview",
      mode: "html",
      content: "<p>x</p>",
      title: "Preview",
    });
  });

  it("render() does NOT store a title key when none is given (clean shape)", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    r.render({ content: "a", view: "v" });
    expect(r.getView("v")).not.toHaveProperty("title");
  });

  it("render() REPLACES a view on re-render to the same id and updatedAt advances", () => {
    let t = 100;
    const r = new RenderService({ urlFor: () => "#", now: () => t });
    r.render({ content: "a", view: "v" });
    t = 200;
    r.render({ content: "b", view: "v" });
    expect(r.getView("v")).toMatchObject({ id: "v", content: "b", updatedAt: 200 });
    expect(r.listViews().length).toBe(1);
  });

  it("listViews() returns every view", () => {
    const r = new RenderService({ urlFor: () => "#" });
    r.render({ content: "a", view: "v1" });
    r.render({ content: "b", view: "v2" });
    const ids = r.listViews().map((v) => v.id).sort();
    expect(ids).toEqual(["v1", "v2"]);
  });

  it("getView() returns undefined for an unknown id", () => {
    const r = new RenderService();
    expect(r.getView("nope")).toBeUndefined();
  });

  it("subscribe() fires (viewId, updatedAt) on each render and the returned fn unsubscribes", () => {
    let t = 1;
    const r = new RenderService({ urlFor: () => "#", now: () => t });
    const seen: Array<[string, number]> = [];
    const off = r.subscribe((viewId, updatedAt) => seen.push([viewId, updatedAt]));
    expect(r.subscriberCount).toBe(1);

    t = 5; r.render({ content: "a", view: "v1" });
    t = 9; r.render({ content: "b", view: "v2" });
    off();
    expect(r.subscriberCount).toBe(0);

    t = 20; r.render({ content: "c", view: "v3" });
    expect(seen).toEqual([
      ["v1", 5],
      ["v2", 9],
    ]);
  });

  it("default urlFor is '#<id>' and default now is wall-clock", () => {
    const r = new RenderService();
    const out = r.render({ content: "x", view: "z" });
    expect(out.url).toBe("#z");
    expect(typeof r.getView("z")?.updatedAt).toBe("number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-service.test.ts )`
Expected: FAIL — `Cannot find module "../src/render-service.js"` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `bun-apps/pi-agent-ext-webui/src/render-service.ts`:

```ts
/**
 * render-service.ts — the in-memory view registry for the generic render
 * framework (specs/06 D1).
 *
 * Pure: no I/O, no `bun`, no `pi`. Holds a Map of named views; `render()`
 * replaces (never appends — v1 is replace-only), advances `updatedAt`, and
 * notifies subscribers. The registry does NOT know the server port: it accepts a
 * `urlFor(viewId)` callback so the caller (T8 wiring) can compose the real URL
 * from `server.url` at render time.
 */
export type RenderMode = "md" | "html";

export interface RenderView {
  id: string;
  mode: RenderMode;
  content: string;
  title?: string;
  updatedAt: number;
}

export interface RenderInput {
  content: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
}

export interface RenderResult {
  viewId: string;
  url: string;
}

export type RenderListener = (viewId: string, updatedAt: number) => void;

export interface RenderServiceOptions {
  /** Compose the browser URL for a view id. Default: `(id) => "#" + id`. */
  urlFor?: (viewId: string) => string;
  /** Injectable clock (epoch ms). Default: `Date.now`. */
  now?: () => number;
}

export class RenderService {
  private readonly views = new Map<string, RenderView>();
  private readonly listeners = new Set<RenderListener>();
  private readonly urlFor: (viewId: string) => string;
  private readonly now: () => number;

  constructor(opts: RenderServiceOptions = {}) {
    this.urlFor = opts.urlFor ?? ((id) => `#${id}`);
    this.now = opts.now ?? (() => Date.now());
  }

  render(input: RenderInput): RenderResult {
    const viewId = input.view ?? "main";
    const mode = input.mode ?? "md";
    const updatedAt = this.now();
    const view: RenderView = {
      id: viewId,
      mode,
      content: input.content,
      ...(input.title !== undefined ? { title: input.title } : {}),
      updatedAt,
    };
    this.views.set(viewId, view);
    for (const listener of this.listeners) {
      try {
        listener(viewId, updatedAt);
      } catch {
        /* a listener must never break render() */
      }
    }
    return { viewId, url: this.urlFor(viewId) };
  }

  listViews(): RenderView[] {
    return [...this.views.values()];
  }

  getView(id: string): RenderView | undefined {
    return this.views.get(id);
  }

  subscribe(listener: RenderListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-service.test.ts )`
Expected: PASS — all 8 cases green.

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-service.ts bun-apps/pi-agent-ext-webui/tests/render-service.test.ts
git commit -m "feat(webui): add pure RenderService view registry (ticket 06 D1)"
```

---

### Task 2: `setHttpRoutes` setter on `WebServer`

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/web-server.ts` (add `HttpRouteHandler` type, `httpRoutes` field, `setHttpRoutes` setter, consult handler inside `fetch`)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (add `setHttpRoutes` to the `WebuiServer` interface)
- Test: `bun-apps/pi-agent-ext-webui/tests/web-server.test.ts` (add a new `describe` block)

**Interfaces:**
- Consumes: the existing `WebServer` class + its `fetch(req, srv: Server<undefined>)` method and the inline `originAllowed` guard.
- Produces:
  - `export type HttpRouteHandler = (req: Request, srv: Server<undefined>) => Response | null` (in `web-server.ts`)
  - `WebServer.setHttpRoutes(handler: HttpRouteHandler | null): void`
  - `WebuiServer.setHttpRoutes(handler: HttpRouteHandler | null): void` (interface addition in `webui-wiring.ts`) — so T8 can call `server.setHttpRoutes(createRenderRoutes(registry))`.
  - **Behavior contract:** `fetch()` consults the handler **after** the origin guard and **before** the `/health`, `/`, `/ws` branches; a handler `return null` falls through to the existing branches. Origin guard still gates every route (loopback-only, D8).

- [ ] **Step 1: Write the failing test**

Append to `bun-apps/pi-agent-ext-webui/tests/web-server.test.ts` (after the existing `describe("WebServer inbound seam", ...)` block):

```ts
// --- WebServer setHttpRoutes (ticket 06 additive route seam) ---------------

describe("WebServer setHttpRoutes", () => {
  it("a registered handler answers its path", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setHttpRoutes((req) => {
      if (new URL(req.url).pathname === "/x") return new Response("from-route");
      return null;
    });
    const res = await fetch(`${s.url}/x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-route");
  });

  it("a null return falls through to the existing /health route", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setHttpRoutes(() => null);
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("with no handler set, existing routes are unchanged", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    const res = await fetch(`${s.url}/health`);
    expect(res.status).toBe(200);
  });

  it("routes are still origin-guarded (non-loopback Origin -> 403)", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setHttpRoutes(() => new Response("x"));
    const res = await fetch(`${s.url}/anything`, { headers: { Origin: "http://evil.com" } });
    expect(res.status).toBe(403);
  });

  it("setHttpRoutes(null) removes a previously-registered handler", async () => {
    const s = makeServer({ port: 0 });
    s.start();
    s.setHttpRoutes(() => new Response("custom", { status: 418 }));
    s.setHttpRoutes(null);
    const res = await fetch(`${s.url}/anything`);
    expect(res.status).toBe(404); // falls back to the default not-found branch
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-server.test.ts )`
Expected: FAIL — `TypeError: s.setHttpRoutes is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `bun-apps/pi-agent-ext-webui/src/web-server.ts`:

3a. Add the handler type. Find the existing `export type CommandHandler = ...` block and add immediately after it:

```ts
/**
 * Additive HTTP route handler seam — set by extensions/webui.ts via
 * {@link WebServer.setHttpRoutes} (ticket 06 D3). Consulted inside `fetch()`
 * AFTER the origin guard and BEFORE the hardcoded /health,/,/ws branches. The
 * handler returns `null` to fall through. Returns loopback-guarded responses
 * (the origin guard already ran).
 */
export type HttpRouteHandler = (
  req: Request,
  srv: Server<undefined>
) => Response | null;
```

3b. Add the field. In the `WebServer` class, next to `private onCommand: CommandHandler | null = null;` add:

```ts
  private httpRoutes: HttpRouteHandler | null = null;
```

3c. Add the setter. Next to the existing `setCommandHandler(cb)` method add:

```ts
  /**
   * Inject additive HTTP routes (ticket 06 D3). `fetch()` consults this handler
   * after the origin guard and before the hardcoded branches; `null` removes it.
   */
  setHttpRoutes(handler: HttpRouteHandler | null): void {
    this.httpRoutes = handler;
  }
```

3d. Consult it in `fetch`. In the `private fetch(req, srv)` method, immediately after the origin-guard `if (origin && !originAllowed(...)) { ... }` block and BEFORE the `if (url.pathname === "/health")` block, insert:

```ts
    if (this.httpRoutes) {
      const res = this.httpRoutes(req, srv);
      if (res) return res;
    }
```

In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, update the imports from `./web-server.js` to also bring in `HttpRouteHandler`, and add `setHttpRoutes` to the `WebuiServer` interface:

```ts
import { WebServer, type CommandHandler, type HttpRouteHandler } from "./web-server.js";
```

```ts
export interface WebuiServer extends Broadcaster {
  start(): void;
  bindSession(pi: unknown, ctx: unknown): void;
  dropSession(): void;
  hasSession(): boolean;
  setCommandHandler(cb: CommandHandler | null): void;
  setHttpRoutes(handler: HttpRouteHandler | null): void;
  stop(): void;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-server.test.ts )`
Expected: PASS — all existing cases plus the 5 new `setHttpRoutes` cases green.

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/web-server.ts bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/web-server.test.ts
git commit -m "feat(webui): add setHttpRoutes DI setter to WebServer (ticket 06 D3)"
```

---

### Task 3: `marked` dependency + pure `renderMarkdown`

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/package.json` (add `marked@^15` dependency)
- Create: `bun-apps/pi-agent-ext-webui/src/render-markdown.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/render-markdown.test.ts`

**Interfaces:**
- Consumes: `marked@^15` (`import { marked } from "marked"` — same import as `pi-agent-ext-wayfind/src/architecture-render.ts`).
- Produces:
  - `export function renderMarkdown(md: string): string` — synchronous md→html via `marked.parse(md, { async: false })`. Used by the `/api/view/:id` route (T4) for `md`-mode views (D3 — server-side rendering; nothing is stored pre-rendered).

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/render-markdown.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { renderMarkdown } from "../src/render-markdown.js";

describe("renderMarkdown", () => {
  it("renders an h1 heading + bold", () => {
    const html = renderMarkdown("# Hello\n\n**world**");
    expect(html).toContain("<h1");
    expect(html).toContain("Hello");
    expect(html).toContain("<strong>world</strong>");
  });

  it("renders a fenced code block", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("renders a list", () => {
    const html = renderMarkdown("- one\n- two\n");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("returns a string (never a Promise)", () => {
    const html = renderMarkdown("# x");
    expect(typeof html).toBe("string");
  });

  it("empty input yields a string", () => {
    expect(typeof renderMarkdown("")).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-markdown.test.ts )`
Expected: FAIL — `Cannot find module "../src/render-markdown.js"`.

- [ ] **Step 3: Add the `marked` dependency**

Edit `bun-apps/pi-agent-ext-webui/package.json` to add a `dependencies` block (the file currently has only `devDependencies`). Insert `"dependencies"` immediately before `"devDependencies"`:

```json
  "dependencies": {
    "marked": "^15"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "typebox": "^1.3.7",
    "typescript": "^7.0.2"
  },
```

Then install from the workspace root (per the monorepo SOP — `bun install` from `bun-apps/`, never the repo root):

```bash
( cd bun-apps && bun install )
```
Expected: install completes; `marked@^15` is added to `bun-apps/bun.lock` and resolvable from the webui package.

- [ ] **Step 4: Write minimal implementation**

Create `bun-apps/pi-agent-ext-webui/src/render-markdown.ts`:

```ts
/**
 * render-markdown.ts — server-side markdown -> HTML (specs/06 D3/D6).
 *
 * `marked@^15` is server-side only; the browser shell never renders markdown
 * itself (it injects the HTML this produces). `{ async: false }` forces the
 * synchronous return so the type narrows to `string`.
 */
import { marked } from "marked";

export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-markdown.test.ts )`
Expected: PASS — all 5 cases green.

- [ ] **Step 6: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/package.json bun-apps/pi-agent-ext-webui/src/render-markdown.ts bun-apps/pi-agent-ext-webui/tests/render-markdown.test.ts bun-apps/bun.lock
git commit -m "feat(webui): add marked@^15 + renderMarkdown (ticket 06 D3/D6)"
```

---

### Task 4: Render HTTP routes module (`/api/views`, `/api/view/:id`, `/api/events` SSE)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/render-routes.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/render-routes.test.ts`

**Interfaces:**
- Consumes:
  - `RenderService` (T1): `render`, `listViews`, `getView`, `subscribe`, `subscriberCount`.
  - `renderMarkdown(md): string` (T3).
  - `WebServer` (T2) + its `setHttpRoutes(handler)` setter for live tests.
  - Test helpers copied from `tests/web-server.test.ts`: `makeServer`, `withTimeout`, `waitFor`.
- Produces:
  - `export type RenderRouteHandler = (req: Request, srv: Server<undefined>) => Response | null` (identical to T2's `HttpRouteHandler` — stays decoupled by importing `Server` from `"bun"`, not from `web-server.ts`).
  - `export function createRenderRoutes(registry: RenderService): RenderRouteHandler`
  - **Route contract (D3):**
    - `GET /api/views` → `200` `application/json`: `[ { id, title: string|null, mode, updatedAt } ]` for every view (empty registry → `[]`).
    - `GET /api/view/:id` → `md`: `200` `{ id, mode, html: renderMarkdown(content), title: string|null, updatedAt }`; `html`: `200` `{ id, mode, content, title: string|null, updatedAt }`; unknown id → `404 "not found"`.
    - `GET /api/events` → `200` `text/event-stream` SSE: enqueues `": connected\n\n"` on open; on each `render()` (via `registry.subscribe`) enqueues `data: ${JSON.stringify({ viewId, updatedAt })}\n\n`; the `ReadableStream.cancel()` (client disconnect) unsubscribes from the registry.
    - Any other path/method → `return null` (fall through to the `WebServer` defaults). **`GET /` is intentionally NOT handled here — it lands in T5.**

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/render-routes.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RenderService } from "../src/render-service.js";

// --- harness (helpers copied from web-server.test.ts) ----------------------

const started: WebServer[] = [];
function makeServer(opts?: { port?: number; hostname?: string }): WebServer {
  const s = new WebServer(opts);
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

function withTimeout<T>(p: Promise<T>, ms = 2000, label = "timed out"): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

async function waitFor(name: string, predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor(${name}) timed out after ${ms}ms`);
}

/** Build a registry + a live WebServer with the render routes installed. */
function setup(now = () => 1000): { registry: RenderService; server: WebServer } {
  const registry = new RenderService({ urlFor: (id) => `http://t/#${id}`, now });
  const server = makeServer({ port: 0 });
  server.setHttpRoutes(createRenderRoutes(registry));
  server.start();
  return { registry, server };
}

// ---------------------------------------------------------------------------

describe("createRenderRoutes — GET /api/views", () => {
  it("returns [] for an empty registry", async () => {
    const { server } = setup();
    const res = await fetch(`${server.url}/api/views`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual([]);
  });

  it("lists every view as { id, title, mode, updatedAt }", async () => {
    const { registry, server } = setup(() => 42);
    registry.render({ content: "a", view: "v1", title: "One" });
    registry.render({ content: "b", view: "v2", mode: "html" });
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(views).toEqual([
      { id: "v1", title: "One", mode: "md", updatedAt: 42 },
      { id: "v2", title: null, mode: "html", updatedAt: 42 },
    ]);
  });
});

describe("createRenderRoutes — GET /api/view/:id", () => {
  it("md view -> { id, mode, html, title, updatedAt } with server-rendered html", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({ content: "# hi", view: "main", title: "Main" });
    const res = await fetch(`${server.url}/api/view/main`);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.id).toBe("main");
    expect(v.mode).toBe("md");
    expect(v.html).toContain("<h1");
    expect(v.html.toLowerCase()).toContain("hi");
    expect(v.title).toBe("Main");
    expect(v.updatedAt).toBe(5);
    expect(v).not.toHaveProperty("content"); // md never leaks raw content
  });

  it("html view -> { id, mode, content, title, updatedAt } (raw content for iframe srcdoc)", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({ content: "<p>raw</p>", view: "p", mode: "html" });
    const v = await (await fetch(`${server.url}/api/view/p`)).json();
    expect(v).toEqual({
      id: "p",
      mode: "html",
      content: "<p>raw</p>",
      title: null,
      updatedAt: 5,
    });
    expect(v).not.toHaveProperty("html");
  });

  it("unknown id -> 404", async () => {
    const { server } = setup();
    const res = await fetch(`${server.url}/api/view/nope`);
    expect(res.status).toBe(404);
  });
});

describe("createRenderRoutes — fall-through", () => {
  it("an unknown path returns null -> WebServer default 404", async () => {
    const { server } = setup();
    const res = await fetch(`${server.url}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it("/health still works (routes do not shadow it)", async () => {
    const { server } = setup();
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("createRenderRoutes — GET /api/events (SSE)", () => {
  it("opens text/event-stream and emits a view_update on render, then unsubscribes on disconnect", async () => {
    const { registry, server } = setup();
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(registry.subscriberCount).toBe(1);

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";

    // initial comment frame
    const first = await withTimeout(reader.read(), 2000, "no initial chunk");
    buf += dec.decode(first.value ?? new Uint8Array(), { stream: true });
    expect(buf).toContain(": connected");

    // push a view -> expect a `data:` frame
    registry.render({ content: "# hi", view: "sse-view" });
    let payload: { viewId?: string; updatedAt?: number } | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !payload) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 40)),
      ]);
      if ("value" in chunk && chunk.value) buf += dec.decode(chunk.value, { stream: true });
      const m = buf.match(/data: (\{.*\})\n\n/);
      if (m) payload = JSON.parse(m[1]);
    }
    expect(payload).toEqual({ viewId: "sse-view", updatedAt: 1000 });

    // disconnect -> subscriber removed (ReadableStream.cancel -> unsubscribe)
    ctrl.abort();
    await waitFor("subscriber removed", () => registry.subscriberCount === 0, 2000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-routes.test.ts )`
Expected: FAIL — `Cannot find module "../src/render-routes.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `bun-apps/pi-agent-ext-webui/src/render-routes.ts`:

```ts
/**
 * render-routes.ts — the additive HTTP adapter over {@link RenderService}
 * (specs/06 D3). Installed via `WebServer.setHttpRoutes(createRenderRoutes(registry))`
 * so the core fetch branches (/health, /, /ws) are untouched (D8 — strictly
 * additive). Every response inherits the existing loopback origin guard (the
 * guard runs before this handler is consulted).
 *
 * Routes:
 *   GET /api/views      -> [{ id, title, mode, updatedAt }]
 *   GET /api/view/:id   -> md: { id, mode, html, title, updatedAt }
 *                          html: { id, mode, content, title, updatedAt }
 *                          absent -> 404
 *   GET /api/events     -> text/event-stream; emits `data:{viewId,updatedAt}`
 *                          on each render(); unsubscribes on client disconnect.
 *   (GET / lives in render-shell.ts / Task 5; everything else -> null fall-through)
 */
import type { Server } from "bun";
import type { RenderService, RenderView } from "./render-service.js";
import { renderMarkdown } from "./render-markdown.js";

export type RenderRouteHandler = (
  req: Request,
  srv: Server<undefined>
) => Response | null;

const encoder = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function viewSummary(v: RenderView): { id: string; title: string | null; mode: string; updatedAt: number } {
  return { id: v.id, title: v.title ?? null, mode: v.mode, updatedAt: v.updatedAt };
}

export function createRenderRoutes(registry: RenderService): RenderRouteHandler {
  return (req) => {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/api/views") {
      return json(registry.listViews().map(viewSummary));
    }

    if (req.method === "GET" && pathname.startsWith("/api/view/")) {
      const id = decodeURIComponent(pathname.slice("/api/view/".length));
      const view = registry.getView(id);
      if (!view) return new Response("not found", { status: 404 });
      if (view.mode === "html") {
        return json({
          id: view.id,
          mode: view.mode,
          content: view.content,
          title: view.title ?? null,
          updatedAt: view.updatedAt,
        });
      }
      return json({
        id: view.id,
        mode: view.mode,
        html: renderMarkdown(view.content),
        title: view.title ?? null,
        updatedAt: view.updatedAt,
      });
    }

    if (req.method === "GET" && pathname === "/api/events") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));
          let closed = false;
          const unsubscribe = registry.subscribe((viewId, updatedAt) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ viewId, updatedAt })}\n\n`)
              );
            } catch {
              closed = true;
            }
          });
          // stash the unsubscribe so cancel() can release the registry listener.
          streamCleanup = unsubscribe;
        },
        cancel() {
          streamCleanup?.();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return null; // fall through to the WebServer defaults
  };
}

// Module-scoped slot used to hand the per-stream unsubscribe from `start` to
// `cancel`. Each /api/events response owns its own ReadableStream; the slot is
// written in `start` and read/cleared in `cancel` before another stream starts.
let streamCleanup: (() => void) | null = null;
```

> Note: `let streamCleanup` is module-scoped and is reassigned on each `start`. Because each SSE response owns its own `ReadableStream` and Bun calls `start` then later `cancel` for a given stream, and the server is single-threaded (JS event loop), this is safe for the v1 single-shell use. If two SSE clients ever connect such that their `start`/`cancel` interleave ambiguously, wrap the slot per-stream — but v1's one-shell, sequential-open usage does not require it.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-routes.test.ts )`
Expected: PASS — all cases green (including the SSE subscribe/disconnect).

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-routes.ts bun-apps/pi-agent-ext-webui/tests/render-routes.test.ts
git commit -m "feat(webui): add createRenderRoutes (api/views, api/view, api/events SSE) (ticket 06 D3)"
```

---

### Task 5: Vanilla browser shell at `GET /`

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/render-shell.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/render-routes.ts` (serve the shell at `GET /`)
- Test: `bun-apps/pi-agent-ext-webui/tests/render-shell.test.ts`

**Interfaces:**
- Consumes:
  - `createRenderRoutes` (T4) — add a `GET /` branch at the **top** of the returned handler (before `/api/*`).
- Produces:
  - `export const RENDER_SHELL_HTML: string` — the complete vanilla-JS shell document. Contains the marker comment `<!-- webui-render-shell -->` (asserted by T8's updated wiring-live-smoke assertion A). Implements D4: on load `GET /api/views` builds tabs + selects `location.hash` (default `"main"`); `GET /api/view/:id` renders `md` (inject server HTML) or `html` (`<iframe sandbox="">` srcdoc, D5); `EventSource('/api/events')` refreshes tabs + re-renders the affected view on `view_update`.
  - **Behavior contract:** `createRenderRoutes` now returns the shell for `GET /`; `null` still for every other unhandled path. (This is the ticket-04 `GET /` stub retirement — D8.3. The stub `STUB_PAGE` in `web-server.ts` becomes unreachable once routes are wired in T8; it is left in place as harmless dead code rather than editing core 04 code.)

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/render-shell.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";
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

describe("RENDER_SHELL_HTML constant", () => {
  it("is a complete HTML document with the marker, tabs pane, content pane, and SSE client", () => {
    expect(RENDER_SHELL_HTML).toContain("<!-- webui-render-shell -->");
    expect(RENDER_SHELL_HTML).toContain("<!doctype html>");
    expect(RENDER_SHELL_HTML).toContain('id="tabs"');
    expect(RENDER_SHELL_HTML).toContain('id="content"');
    expect(RENDER_SHELL_HTML).toContain("EventSource('/api/events')");
    expect(RENDER_SHELL_HTML).toContain("/api/view/");
  });

  it("sandboxes html-mode content (iframe sandbox attribute, no allow-scripts)", () => {
    // The shell builds the iframe via JS and sets an EMPTY sandbox (most
    // restrictive — no allow-scripts, no allow-same-origin) per spec D5.
    expect(RENDER_SHELL_HTML).toContain("setAttribute('sandbox', '')");
    expect(RENDER_SHELL_HTML).not.toContain("allow-scripts");
  });
});

describe("createRenderRoutes — GET / serves the shell", () => {
  it("GET / returns 200 text/html RENDER_SHELL_HTML", async () => {
    const registry = new RenderService();
    const server = makeServer();
    server.setHttpRoutes(createRenderRoutes(registry));
    server.start();
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toBe(RENDER_SHELL_HTML);
    expect(body).toContain("webui-render-shell");
  });

  it("GET / is served BEFORE /api/* (does not shadow api routes)", async () => {
    const registry = new RenderService();
    registry.render({ content: "# x", view: "main" });
    const server = makeServer();
    server.setHttpRoutes(createRenderRoutes(registry));
    server.start();
    const shell = await (await fetch(`${server.url}/`)).text();
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(shell).toContain("webui-render-shell");
    expect(views.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell.test.ts )`
Expected: FAIL — `Cannot find module "../src/render-shell.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `bun-apps/pi-agent-ext-webui/src/render-shell.ts`:

```ts
/**
 * render-shell.ts — the vanilla browser shell (specs/06 D4/D5). A single inline
 * HTML document (string constant, like web-access's generateCuratorPage): no
 * React, no Bun.build, no committed dist/. Served at GET / by createRenderRoutes
 * (render-routes.ts), RETIRING the ticket-04 connect-test stub (D8.3).
 *
 * Client behavior (D4):
 *   - on load: GET /api/views -> render tabs; select location.hash (or "main").
 *   - GET /api/view/:id -> md injects the server-rendered html; html sets an
 *     <iframe sandbox=""> (no allow-scripts / allow-same-origin) srcdoc (D5).
 *   - EventSource('/api/events') -> on view_update refresh tabs + re-render the
 *     affected view.
 */
export const RENDER_SHELL_HTML = `<!-- webui-render-shell -->
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
const tabsEl = document.getElementById('tabs');
const metaEl = document.getElementById('meta');
const contentEl = document.getElementById('content');
let activeId = location.hash.slice(1) || 'main';

function fmtTime(ms) { try { return new Date(ms).toLocaleString(); } catch { return ''; } }

async function loadViews() {
  const res = await fetch('/api/views');
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
  const res = await fetch('/api/view/' + encodeURIComponent(id));
  if (!res.ok) { contentEl.innerHTML = '<p>no view</p>'; return; }
  const v = await res.json();
  document.querySelectorAll('.tab').forEach(function (t) {
    t.classList.toggle('active', t.dataset.viewId === id);
  });
  metaEl.textContent = (v.title ? (v.title + ' · ') : '') + 'mode ' + v.mode + ' · updated ' + fmtTime(v.updatedAt);
  if (v.mode === 'html') {
    contentEl.innerHTML = '';
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', ''); // D5: no allow-scripts, no allow-same-origin
    f.srcdoc = v.content;
    contentEl.appendChild(f);
  } else {
    contentEl.innerHTML = v.html || '';
  }
}

async function refresh() { await loadViews(); await renderView(activeId); }

function subscribe() {
  const es = new EventSource('/api/events');
  es.onmessage = async function (e) {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (data && data.viewId) { await loadViews(); if (data.viewId === activeId) await renderView(activeId); }
  };
  es.onerror = function () { es.close(); setTimeout(subscribe, 2000); };
}

(async function () { await refresh(); subscribe(); })();
</script>
</body>
</html>`;
```

Then modify `bun-apps/pi-agent-ext-webui/src/render-routes.ts`: add the import at the top and a `GET /` branch as the **first** check inside the returned handler.

Add the import (with the other imports):

```ts
import { RENDER_SHELL_HTML } from "./render-shell.js";
```

Add the branch. Replace the opening of the returned handler:

```ts
  return (req) => {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/") {
      return new Response(RENDER_SHELL_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "GET" && pathname === "/api/views") {
```

(Leave the rest of the handler unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell.test.ts )`
Expected: PASS — all cases green.

- [ ] **Step 5: Run the render-routes suite to confirm no regression**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-routes.test.ts )`
Expected: PASS (the `GET /` branch is added before `/api/*`; all `/api/*` cases still pass).

- [ ] **Step 6: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-shell.ts bun-apps/pi-agent-ext-webui/src/render-routes.ts bun-apps/pi-agent-ext-webui/tests/render-shell.test.ts
git commit -m "feat(webui): add vanilla render shell served at GET / (ticket 06 D4/D5)"
```

---

### Task 6: `webui_render` tool (pure factory)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/render-tool.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/render-tool.test.ts`

**Interfaces:**
- Consumes:
  - `RenderService` (T1): `render({ content, mode?, view?, title? }): RenderResult`.
  - `import { Type } from "typebox"` (webui devDep; same import as `protocol.ts`).
  - `import type { ToolDefinition } from "@earendil-works/pi-coding-agent"` — verified typecheck-clean from `src/` (probe passed). `ToolDefinition<TParams, TDetails>` shape: `{ name, label, description, promptSnippet?, parameters, execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>> }`. `AgentToolResult<T> = { content: (TextContent|ImageContent)[], details: T, ... }`.
- Produces:
  - `export function createRenderTool(registry: RenderService): ToolDefinition<typeof RenderParameters, { viewId: string; url: string }>`
  - **Tool contract (D2):** `name: "webui_render"`; `parameters` is `Type.Object({ content: Type.String(...), mode: Type.Optional(Type.Union([Type.Literal("md"), Type.Literal("html")], ...)), view: Type.Optional(Type.String(...)), title: Type.Optional(Type.String(...)) })`; `execute(callId, params, signal, onUpdate, ctx)` calls `registry.render({ content, mode?, view?, title? })` and returns `{ content: [{ type: "text", text: <url> }], details: { viewId, url } }`. This is the only LLM-callable entry point.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/render-tool.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createRenderTool } from "../src/render-tool.js";
import { RenderService } from "../src/render-service.js";

describe("createRenderTool", () => {
  it("returns a tool named webui_render with the TypeBox parameter schema", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const tool = createRenderTool(registry);
    expect(tool.name).toBe("webui_render");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties).toHaveProperty("content");
    expect(tool.parameters.properties).toHaveProperty("mode");
    expect(tool.parameters.properties).toHaveProperty("view");
    expect(tool.parameters.properties).toHaveProperty("title");
  });

  it("execute() renders to the registry (default view 'main', mode 'md') and returns the url", async () => {
    const registry = new RenderService({ urlFor: (id) => `http://test/#${id}`, now: () => 1 });
    const tool = createRenderTool(registry);
    const out = await tool.execute("call-1", { content: "# hi" }, undefined, undefined, {} as never);
    expect(out.content).toEqual([{ type: "text", text: "http://test/#main" }]);
    expect(out.details).toEqual({ viewId: "main", url: "http://test/#main" });
    expect(registry.getView("main")).toMatchObject({ id: "main", mode: "md", content: "# hi" });
  });

  it("execute() forwards view/mode/title", async () => {
    const registry = new RenderService({ urlFor: (id) => `http://test/#${id}`, now: () => 42 });
    const tool = createRenderTool(registry);
    const out = await tool.execute(
      "call-2",
      { content: "<p>x</p>", mode: "html", view: "preview", title: "Preview" },
      undefined,
      undefined,
      {} as never
    );
    expect(out.details).toEqual({ viewId: "preview", url: "http://test/#preview" });
    expect(registry.getView("preview")).toMatchObject({
      id: "preview",
      mode: "html",
      content: "<p>x</p>",
      title: "Preview",
      updatedAt: 42,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-tool.test.ts )`
Expected: FAIL — `Cannot find module "../src/render-tool.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `bun-apps/pi-agent-ext-webui/src/render-tool.ts`:

```ts
/**
 * render-tool.ts — the LLM-callable producer entry point (specs/06 D2).
 *
 * `createRenderTool(registry)` builds the `webui_render` ToolDefinition. Its
 * execute() is a thin adapter over RenderService.render(): it maps the tool
 * params to a RenderInput and returns the view URL as the tool result text
 * ({ content:[{type:"text",text:url}], details:{viewId,url} }). This is the
 * only producer path reachable from a skill (skills have no host handle).
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RenderMode, RenderService } from "./render-service.js";

export const RenderParameters = Type.Object({
  content: Type.String({ description: "Markdown or HTML to render in the browser." }),
  mode: Type.Optional(
    Type.Union([Type.Literal("md"), Type.Literal("html")], {
      description: "Render mode. Default 'md'.",
    })
  ),
  view: Type.Optional(Type.String({ description: "Named view id. Default 'main'." })),
  title: Type.Optional(Type.String({ description: "Optional view title shown in the shell." })),
});

export function createRenderTool(
  registry: RenderService
): ToolDefinition<typeof RenderParameters, { viewId: string; url: string }> {
  return {
    name: "webui_render",
    label: "Render",
    description:
      "Render markdown or HTML into a browser view served by the webui extension. " +
      "Markdown is formatted (headings, lists, tables, code blocks); HTML is shown in a sandboxed iframe. " +
      "Returns the browser URL of the view. Open the URL in a browser to see the latest content, which updates live.",
    promptSnippet:
      "Use to render rich content (markdown or HTML) to the webui browser surface; returns the browser URL.",
    parameters: RenderParameters,
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      const result = registry.render({
        content: params.content,
        ...(params.mode !== undefined ? { mode: params.mode as RenderMode } : {}),
        ...(params.view !== undefined ? { view: params.view } : {}),
        ...(params.title !== undefined ? { title: params.title } : {}),
      });
      return {
        content: [{ type: "text", text: result.url }],
        details: { viewId: result.viewId, url: result.url },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-tool.test.ts )`
Expected: PASS — all 3 cases green.

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0) — confirms the `ToolDefinition` import + return shape type-check.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-tool.ts bun-apps/pi-agent-ext-webui/tests/render-tool.test.ts
git commit -m "feat(webui): add webui_render tool factory (ticket 06 D2)"
```

---

### Task 7: Render event-channel handler (pure factory)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/render-event-handler.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/render-event-handler.test.ts`

**Interfaces:**
- Consumes:
  - `RenderService` (T1): `render({ content, mode?, view?, title? })`.
  - `EventBus.on(channel, handler)` shape: `on(channel: string, handler: (data: unknown) => void): () => void` (the pi host's `events.on` — T8 wires `createRenderEventHandler(registry)` as the `"webui:render"` handler).
- Produces:
  - `export interface RenderEventPayload { content: string; mode?: RenderMode; view?: string; title?: string }`
  - `export type RenderEventHandler = (data: unknown) => void`
  - `export function createRenderEventHandler(registry: RenderService): RenderEventHandler` — validates `data` (must be an object with a string `content`; `mode` honored only if `"md"`/`"html"`; `view`/`title` honored only if strings) and calls `registry.render(...)`. Invalid payloads are ignored (never throw — the host event bus must not crash on bad input). This is the extension-producer path (`pi.events.emit("webui:render", {content, mode, view, title})`).

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/render-event-handler.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createRenderEventHandler } from "../src/render-event-handler.js";
import { RenderService } from "../src/render-service.js";

describe("createRenderEventHandler", () => {
  it("a valid payload lands in the registry (default view 'main', mode 'md')", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 7 });
    const handler = createRenderEventHandler(registry);
    handler({ content: "# hi" });
    expect(registry.getView("main")).toMatchObject({ id: "main", mode: "md", content: "# hi", updatedAt: 7 });
  });

  it("forwards view/mode/title", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 7 });
    const handler = createRenderEventHandler(registry);
    handler({ content: "<p>x</p>", mode: "html", view: "v1", title: "T" });
    expect(registry.getView("v1")).toMatchObject({
      id: "v1",
      mode: "html",
      content: "<p>x</p>",
      title: "T",
      updatedAt: 7,
    });
  });

  it("ignores an invalid mode (falls back to 'md')", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handler = createRenderEventHandler(registry);
    handler({ content: "x", mode: "bogus" });
    expect(registry.getView("main")?.mode).toBe("md");
  });

  it("ignores malformed payloads without throwing", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const handler = createRenderEventHandler(registry);
    expect(() => handler(null)).not.toThrow();
    expect(() => handler(undefined)).not.toThrow();
    expect(() => handler({})).not.toThrow();
    expect(() => handler({ content: 123 })).not.toThrow();
    expect(() => handler("nope")).not.toThrow();
    expect(() => handler({ mode: "md" })).not.toThrow(); // missing content
    expect(registry.listViews()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-event-handler.test.ts )`
Expected: FAIL — `Cannot find module "../src/render-event-handler.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `bun-apps/pi-agent-ext-webui/src/render-event-handler.ts`:

```ts
/**
 * render-event-handler.ts — the extension-producer entry point (specs/06 D2).
 *
 * `createRenderEventHandler(registry)` returns the handler registered as
 * `pi.events.on("webui:render", handler)` by wireWebui (T8). Any extension
 * emits `pi.events.emit("webui:render", { content, mode?, view?, title? })`;
 * this validates the payload and dispatches it into the registry. Invalid
 * payloads are ignored (never throw — the shared event bus must stay robust).
 */
import type { RenderMode, RenderService } from "./render-service.js";

export interface RenderEventPayload {
  content: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
}

export type RenderEventHandler = (data: unknown) => void;

function isPayload(d: unknown): d is RenderEventPayload {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return typeof o.content === "string";
}

export function createRenderEventHandler(registry: RenderService): RenderEventHandler {
  return (data) => {
    if (!isPayload(data)) return;
    registry.render({
      content: data.content,
      ...(data.mode === "md" || data.mode === "html" ? { mode: data.mode } : {}),
      ...(typeof data.view === "string" ? { view: data.view } : {}),
      ...(typeof data.title === "string" ? { title: data.title } : {}),
    });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-event-handler.test.ts )`
Expected: PASS — all 4 cases green.

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-event-handler.ts bun-apps/pi-agent-ext-webui/tests/render-event-handler.test.ts
git commit -m "feat(webui): add webui:render event-channel handler factory (ticket 06 D2)"
```

---

### Task 8: Wire everything in `wireWebui` + integration tests + smoke assertion update

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (widen `WebuiHost` with `events` + `registerTool`; construct the registry; install routes/tool/event)
- Modify: `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts` (update `MockPi` for the widened host; update assertion A — `GET /` now serves the shell)
- Test: `bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts` (new — end-to-end + decoupling negative control)

**Interfaces:**
- Consumes (all from T1–T7):
  - `RenderService` (T1), `createRenderRoutes` (T4), `createRenderTool` (T6), `createRenderEventHandler` (T7).
  - `WebServer.setHttpRoutes` (T2) + `WebuiServer.setHttpRoutes`.
  - `ExtensionAPI.events: EventBus` = `{ emit(channel, data): void; on(channel, handler): () => void }`; `ExtensionAPI.registerTool(tool): void` (verified shapes from the SDK `.d.ts`).
  - Test host from `tests/wiring-live-smoke.test.ts`: `MockPi`, `makeServer`, `withTimeout`, `waitFor`, `openWs`, `setup()`.
- Produces:
  - `export interface RenderHostEvents { on(channel: string, handler: (data: unknown) => void): () => void; emit(channel: string, data: unknown): void }` (in `webui-wiring.ts`)
  - Widened `WebuiHost`: adds `events: RenderHostEvents` and `registerTool(tool: unknown): void`. (The real `ExtensionAPI` is a structural superset; `extensions/webui.ts`'s existing cast still holds.)
  - Wired `wireWebui`: constructs `new RenderService({ urlFor: (id) => server.url + "/#" + id })`, calls `server.setHttpRoutes(createRenderRoutes(registry))`, `pi.registerTool(createRenderTool(registry))`, `pi.events.on("webui:render", createRenderEventHandler(registry))`; `dispose()` calls `server.setHttpRoutes(null)`.

- [ ] **Step 1: Write the failing integration test**

Create `bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts`:

```ts
/**
 * render-integration.test.ts — end-to-end for the generic render framework
 * (ticket 06), driving the REAL wireWebui composition root against a minimal
 * MockPi host + a REAL WebServer. Mirrors wiring-live-smoke.test.ts's harness
 * (withTimeout / waitFor / openWs / MockPi), extended with the render seams
 * (events + registerTool) the widened WebuiHost now requires.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import {
  wireWebui,
  type WebuiHost,
  type WebuiWiring,
  type RenderHostEvents,
} from "../src/webui-wiring.js";

// --- harness (copied + extended from wiring-live-smoke.test.ts) ------------

const started: WebServer[] = [];
function makeServer(): WebServer {
  const s = new WebServer({ port: 0 });
  started.push(s);
  return s;
}
const wirings: WebuiWiring[] = [];
const openClients: WebSocket[] = [];

afterEach(() => {
  while (wirings.length) {
    try { wirings.pop()!.dispose(); } catch { /* ignore */ }
  }
  for (const ws of openClients) { try { ws.close(); } catch { /* ignore */ } }
  openClients.length = 0;
  while (started.length) { try { started.pop()!.stop(); } catch { /* ignore */ } }
});

function withTimeout<T>(p: Promise<T>, ms = 2000, label = "timed out"): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}
async function waitFor(name: string, predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor(${name}) timed out after ${ms}ms`);
}
function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  openClients.push(ws);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws open failed"));
  });
}

/** Minimal-but-real WebuiHost. Adds the render seams (events + registerTool)
 *  the widened interface now requires. */
class MockPi implements WebuiHost {
  readonly handlers = new Map<string, (event: any, ctx: any) => any>();
  readonly sent: Array<{ content: string | unknown[]; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  readonly registeredTools: unknown[] = [];
  readonly events: RenderHostEvents;
  aborts = 0;

  constructor() {
    const channels = new Map<string, Set<(data: unknown) => void>>();
    this.events = {
      on(channel, handler) {
        let set = channels.get(channel);
        if (!set) { set = new Set(); channels.set(channel, set); }
        set.add(handler);
        return () => { set!.delete(handler); };
      },
      emit(channel, data) {
        channels.get(channel)?.forEach((h) => h(data));
      },
    };
  }

  on(event: string, handler: (event: any, ctx: any) => any): void {
    this.handlers.set(event, handler);
  }
  sendUserMessage(content: string | unknown[], opts?: { deliverAs?: "steer" | "followUp" }): void {
    this.sent.push({ content, opts });
  }
  registerTool(tool: unknown): void {
    this.registeredTools.push(tool);
  }

  /** Replay a pi.on(...) handler (mirrors wiring-live-smoke). */
  emit(event: string, payload: any = {}, ctx: any = undefined): any {
    const h = this.handlers.get(event);
    return h ? h(payload, ctx) : undefined;
  }
  ctx(): { abort(): void } {
    const self = this;
    return { abort() { self.aborts++; } };
  }
}

function setup(): { pi: MockPi; server: WebServer; wiring: WebuiWiring } {
  const pi = new MockPi();
  const server = makeServer();
  const wiring = wireWebui(pi, { server });
  wirings.push(wiring);
  return { pi, server, wiring };
}

// ---------------------------------------------------------------------------

describe("wireWebui render framework — end-to-end", () => {
  it("registers the webui_render tool + webui:render subscription during wiring", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tools = pi.registeredTools as Array<{ name: string }>;
    expect(tools.some((t) => t.name === "webui_render")).toBe(true);
    // the event subscription routes into the registry: emit -> GET /api/view/:id
    pi.events.emit("webui:render", { content: "# hello", view: "preview", title: "P" });
    const res = await fetch(`${server.url}/api/view/preview`);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.mode).toBe("md");
    expect(v.html).toContain("<h1");
    expect(v.title).toBe("P");
  });

  it("the tool execute() path lands in the same registry and is served", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tool = (pi.registeredTools as Array<{ name: string; execute: (...a: any[]) => Promise<any> }>)
      .find((t) => t.name === "webui_render")!;
    const out = await tool.execute("c1", { content: "**bold**", view: "toolview" }, undefined, undefined, {});
    expect(out.details.url).toContain("/#toolview");
    const v = await (await fetch(`${server.url}/api/view/toolview`)).json();
    expect(v.html).toContain("<strong>bold</strong>");
  });

  it("GET / serves the render shell after wiring", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const body = await (await fetch(`${server.url}/`)).text();
    expect(body).toContain("webui-render-shell");
  });

  it("render() returns the loopback URL composed from server.url", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tool = (pi.registeredTools as Array<{ name: string; execute: (...a: any[]) => Promise<any> }>)
      .find((t) => t.name === "webui_render")!;
    const out = await tool.execute("c", { content: "x", view: "z" }, undefined, undefined, {});
    expect(out.details.url).toBe(`${server.url}/#z`);
  });

  it("GET /api/events SSE delivers a view_update on webui:render", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events`, { signal: ctrl.signal });
    expect(res.headers.get("content-type") || "").toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const first = await withTimeout(reader.read(), 2000, "no initial chunk");
    buf += dec.decode(first.value ?? new Uint8Array(), { stream: true });
    expect(buf).toContain(": connected");
    pi.events.emit("webui:render", { content: "# hi", view: "sse-view" });
    let payload: { viewId?: string; updatedAt?: number } | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !payload) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 40)),
      ]);
      if ("value" in chunk && chunk.value) buf += dec.decode(chunk.value, { stream: true });
      const m = buf.match(/data: (\{.*\})\n\n/);
      if (m) payload = JSON.parse(m[1]);
    }
    expect(payload).toMatchObject({ viewId: "sse-view" });
    ctrl.abort();
  });
});

describe("wireWebui render framework — decoupling (spec D8)", () => {
  it("the render path does NOT call sendUserMessage and does NOT broadcast a mutex_blocked frame", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // Observe any broadcast on the chat WS (mutex_blocked would arrive here).
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);
    let gotFrame = false;
    ws.onmessage = () => { gotFrame = true; };

    // Drive BOTH producer paths.
    pi.events.emit("webui:render", { content: "# via-event" });
    const tool = (pi.registeredTools as Array<{ name: string; execute: (...a: any[]) => Promise<any> }>)
      .find((t) => t.name === "webui_render")!;
    await tool.execute("c", { content: "# via-tool", view: "t" }, undefined, undefined, {});

    await Bun.sleep(100); // give any (absent) broadcast time to never arrive
    expect(pi.sent).toEqual([]); // render never injects a user message
    expect(gotFrame).toBe(false); // no mutex_blocked / no chat frame on the render path
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-integration.test.ts )`
Expected: FAIL — type errors at runtime about missing `pi.events`/`pi.registerTool`, and no `webui_render` tool registered (the wiring does not wire it yet).

- [ ] **Step 3: Write minimal implementation**

3a. In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, add the imports for the four render modules near the existing imports:

```ts
import { RenderService } from "./render-service.js";
import { createRenderRoutes } from "./render-routes.js";
import { createRenderTool } from "./render-tool.js";
import { createRenderEventHandler } from "./render-event-handler.js";
```

3b. Widen `WebuiHost`. Add the `RenderHostEvents` interface and the two new members to `WebuiHost`. Replace the existing `WebuiHost` interface with:

```ts
/**
 * The event-bus surface the render framework needs (ticket 06 D2). The real
 * SDK `EventBus` is `{ emit(channel,data): void; on(channel,handler): () => void }`
 * — this mirrors exactly that so a MockPi stub is tiny.
 */
export interface RenderHostEvents {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

/**
 * The minimal pi host surface wireWebui touches: a many-event `on` registrar,
 * `sendUserMessage`, plus the ticket-06 render seams (`events` + `registerTool`).
 * Narrow on purpose so a MockPi in tests is tiny; the real {@link ExtensionAPI}
 * is a structural superset (assigned at the extensions/webui.ts entry via a cast).
 */
export interface WebuiHost {
  on(event: string, handler: (event: any, ctx: any) => any): void;
  sendUserMessage(
    content: string | unknown[],
    opts?: { deliverAs?: "steer" | "followUp" }
  ): void;
  /** Shared event bus (ticket 06 render channel "webui:render"). */
  events: RenderHostEvents;
  /** Tool registrar (ticket 06 registers "webui_render"). */
  registerTool(tool: unknown): void;
}
```

3c. Wire the render framework inside `wireWebui`. Locate the line `server.setCommandHandler(onCommand);` and immediately **after** it add:

```ts
  // --- render framework (ticket 06 D2/D3) ---------------------------------
  // The registry is constructed here (not via deps) so it owns a urlFor bound
  // to THIS server. urlFor reads server.url lazily at render() time — the server
  // starts on the first session_start, which fires AFTER wireWebui returns, so
  // server.url is unavailable during wiring (the closure defers the read).
  const registry = new RenderService({
    urlFor: (id) => `${server.url}/#${id}`,
  });
  server.setHttpRoutes(createRenderRoutes(registry));
  pi.registerTool(createRenderTool(registry));
  pi.events.on("webui:render", createRenderEventHandler(registry));
```

3d. Neutralize render routes on dispose. In the `dispose()` method, immediately after `disposed = true;`, add:

```ts
      server.setHttpRoutes(null);
```

(The existing `server.stop()` in dispose tears down any open SSE connections, whose `ReadableStream.cancel()` releases the registry subscribers.)

3e. Update `MockPi` in `bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts` so it satisfies the widened `WebuiHost`. Replace the existing `class MockPi implements WebuiHost { ... }` with:

```ts
class MockPi implements WebuiHost {
  readonly handlers = new Map<string, (event: any, ctx: any) => any>();
  readonly sent: Array<{ content: string | unknown[]; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  readonly registeredTools: unknown[] = [];
  readonly events: RenderHostEvents;
  aborts = 0;

  constructor() {
    const channels = new Map<string, Set<(data: unknown) => void>>();
    this.events = {
      on(channel, handler) {
        let set = channels.get(channel);
        if (!set) { set = new Set(); channels.set(channel, set); }
        set.add(handler);
        return () => { set!.delete(handler); };
      },
      emit(channel, data) {
        channels.get(channel)?.forEach((h) => h(data));
      },
    };
  }

  on(event: string, handler: (event: any, ctx: any) => any): void {
    this.handlers.set(event, handler);
  }

  sendUserMessage(
    content: string | unknown[],
    opts?: { deliverAs?: "steer" | "followUp" }
  ): void {
    this.sent.push({ content, opts });
  }

  registerTool(tool: unknown): void {
    this.registeredTools.push(tool);
  }

  /** Replay a pi host event into the wiring's real registered handler. */
  emit(event: string, payload: any = {}, ctx: any = undefined): any {
    const h = this.handlers.get(event);
    return h ? h(payload, ctx) : undefined;
  }

  /** A fake session ctx whose abort() is observable. */
  ctx(): { abort(): void } {
    const self = this;
    return {
      abort() {
        self.aborts++;
      },
    };
  }
}
```

And update the import line at the top of `wiring-live-smoke.test.ts` to also pull in `RenderHostEvents`:

```ts
import { wireWebui, type WebuiHost, type WebuiWiring, type RenderHostEvents } from "../src/webui-wiring.js";
```

3f. Update assertion A. In `wiring-live-smoke.test.ts`, replace the body of the `it("A) ...")` test:

```ts
  it("A) after session_start, GET / serves the render shell (ticket 06)", async () => {
    const { pi, server, wiring } = setup();
    pi.emit("session_start", {}, pi.ctx());
    wiring; // referenced for clarity
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("webui-render-shell");
  });
```

(Previously it asserted `body` contained `"webui connect-test"` and `"/ws"` — that stub is now retired by the render shell served via the wired routes, per D8.3.)

- [ ] **Step 4: Run the new integration test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-integration.test.ts )`
Expected: PASS — all end-to-end + the decoupling negative-control cases green.

- [ ] **Step 5: Run the updated wiring-live-smoke to verify no regression**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/wiring-live-smoke.test.ts )`
Expected: PASS — A (now shell), B, C, D, E, E2, F, F2 all green (the render wiring is additive and does not touch the chat/mutex path).

- [ ] **Step 6: Run the whole suite + typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`
Expected: typecheck PASS (no output, exit 0); every test file green, including the pre-existing `web-server.test.ts` (the `GET /` stub-page test there uses a bare `WebServer` with no routes installed, so it still returns `STUB_PAGE` and stays green — only the *wired* `GET /` changed).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/wiring-live-smoke.test.ts bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts
git commit -m "feat(webui): wire render framework (registry + routes + tool + event) into wireWebui (ticket 06 D2/D3/D8)"
```

---

## Notes for the implementer

- **Decoupling is load-bearing (D8).** If any render code path needs to call `pi.sendUserMessage`, acquire a mutex, or send a `/ws` frame, stop — that is a design violation. The negative-control test in T8 guards this permanently.
- **`server.url` is lazy.** The registry's `urlFor` closure captures `server` and reads `server.url` only at `render()` time (post-`session_start`). Never read `server.url` during `wireWebui`.
- **`GET /` stub retirement is wiring-level.** The `STUB_PAGE` constant in `web-server.ts` is left in place as harmless dead code (do not edit core 04 code); it is simply unreachable once the render routes are wired. The standalone `web-server.test.ts` stub-page test continues to pass because it never installs routes.
- **SSE is a distinct client set** from `/ws` (D3). Do not unify them in v1.
- **No build step.** The shell is a string constant in `src/`; nothing is written to `dist/` for the browser.
