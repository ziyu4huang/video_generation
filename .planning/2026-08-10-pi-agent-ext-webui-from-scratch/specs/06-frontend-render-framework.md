# Spec — webui Generic Render Framework (Ticket 06, reframed)

> **Redirect note.** Ticket 06 was originally framed as "frontend-stack-delivery" (pick a React stack, clone the `gui-movie-director` template). Per session decision it is reframed to a **generic, decoupled render framework**: producers push markdown/HTML into named views; a vanilla browser shell renders them. Stack decision: **vanilla, no build step**. This supersedes the ticket's original Question; the ticket file (`tickets/06-frontend-stack-delivery.md`) and `map.md` decisions log should be cross-referenced at commit time.

**Status:** draft (pending user review)
**Effort:** `.planning/2026-08-10-pi-agent-ext-webui-from-scratch/`
**Depends on:** ticket 04 (web transport & protocol) — MERGED. Reuses the 04 `WebServer` (Bun.serve, loopback, origin guard, ephemeral port) as the HTTP host. **Does not** depend on the 04 `/ws` chat frames or the mutex.
**Blocks:** nothing formal. Enables ticket 05 (rich rendering) to land dedicated renderers into the shell later.

---

## Problem Statement

The TUI cannot render rich content. Markdown arrives as raw text (no headings/lists/tables/code formatting); HTML and images cannot be shown at all. Extensions, tools, and skills routinely produce markdown/HTML results — generated reports, page previews, structured docs, image references — whose value is destroyed when flattened into the terminal. There is no generic, reusable way for any producer to push rich content to a browser surface the agent already serves.

## Solution

A generic, **decoupled** render framework inside the `pi-agent-ext-webui` extension. Any producer calls `webui.render(content, {mode, view})` to push markdown or HTML into a named in-memory **view**. A vanilla browser page served by the existing webui `Bun.serve` (no build step, no committed artifacts) renders each view's content — markdown → HTML (server-side via `marked`) or raw HTML in a sandboxed iframe — and updates **live via Server-Sent Events**.

It is fully decoupled from the ticket-04 chat/mutex/co-drive transport: additive HTTP routes + an SSE channel + a view registry + a tool + an event subscription. It touches **none** of `/ws`, `pi.on("input")`, the mutex, or `sendUserMessage`.

## User Stories

1. As the agent, I want to render a markdown report I generated, so the user sees it formatted (headings, lists, tables, code blocks) instead of raw text.
2. As the agent, I want to render an HTML snippet (e.g. a generated page preview), so the user sees it rendered in a sandboxed browser pane.
3. As the agent, I want to render to a named view (e.g. "preview"), so multiple distinct outputs coexist and the user can switch between them.
4. As the agent, I want `render()` to return the browser URL, so I can tell the user where to look.
5. As an extension author, I want to call `webui.render()` programmatically without going through the LLM, so my extension pushes rich output directly.
6. As a skill author, I want to render content by instructing the model to call a tool, since skills have no direct host handle.
7. As a user, I want to open a browser URL and see the latest rendered content, updating live as the agent produces more.
8. As a user, I want each view to show its title and last-updated time, so I can tell fresh from stale.
9. As a user, I want HTML content sandboxed, so agent-generated HTML cannot run scripts or touch my session.
10. As a user, I want the surface served only on loopback, so it is not exposed to the network.
11. As a user, I want the framework to need no build step and no committed artifacts, so it stays simple and always works.
12. As an extension author, I want the render framework decoupled from the chat/mutex transport, so using it does not couple me to the co-drive UI.
13. As the agent, I want the default view to just work (no view id required), so a one-off render is a single argument.
14. As a user, I want the render shell to list all views as tabs, so I can navigate between concurrent outputs.
15. As a maintainer, I want the render routes added without editing the core chat/mutex server logic, so the framework stays isolated and testable.

## Implementation Decisions

### D1 — Render service (core registry)
An in-memory view registry, singleton within the webui extension:

```ts
type RenderMode = "md" | "html";
interface RenderView {
  id: string;            // view id; default "main"
  mode: RenderMode;
  content: string;       // raw md or html
  title?: string;
  updatedAt: number;     // epoch ms
}
interface RenderInput { content: string; mode?: RenderMode; view?: string; title?: string; }
interface RenderResult { viewId: string; url: string; }
```
Operations: `render(input): RenderResult` (replace semantics; creates the view if absent; default view `"main"`, default mode `"md"`); `listViews(): RenderView[]`; `getView(id): RenderView | undefined`. Markdown is rendered to HTML **server-side** by the route (D3), not stored pre-rendered.

### D2 — Producer entry points (two, one registry)
- **Tool `webui_render`** (skill/LLM path — skills have no host handle). Registered via `pi.registerTool({...})`; TypeBox via `import { Type } from "typebox"` (webui's existing devDep). Parameters:
```ts
Type.Object({
  content: Type.String({ description: "Markdown or HTML to render in the browser." }),
  mode:    Type.Optional(Type.Union([Type.Literal("md"), Type.Literal("html")],
               { description: "Render mode. Default 'md'." })),
  view:    Type.Optional(Type.String({ description: "Named view id. Default 'main'." })),
  title:   Type.Optional(Type.String({ description: "Optional view title shown in the shell." })),
})
```
`execute(callId, params, signal, onUpdate, ctx)` calls the registry's `render()`, returns `{ content: [{ type: "text", text: <url> }], details: { viewId, url } }`. This is the extension's first tool.
- **Event channel** (extension path). Any extension emits `pi.events.emit("webui:render", { content, mode, view, title })`; webui subscribes via `pi.events.on("webui:render", ...)` inside `wireWebui`. `pi.events: EventBus` (`emit(channel,data)` / `on(channel,handler) → unsubscribe`) is this repo's documented extension↔extension seam.

### D3 — HTTP routes (on the existing WebServer; decoupled via setter injection)
Add a setter `setHttpRoutes(handler: (req, srv) => Response | null)` on `WebServer`, mirroring the existing `setCommandHandler` DI-by-setter pattern. `fetch()` consults it **before** the hardcoded `/health`, `/`, `/ws` branches; the handler returns `null` to fall through. The render module registers its routes through this setter — **no edits to the core fetch branches or the chat/mutex path**.

Routes (all loopback-only via the existing `originAllowed` guard):
- `GET /` → the vanilla browser shell HTML (see D4). **Replaces the ticket-04 connect-test stub page** (the stub is retired; `/health` remains).
- `GET /api/views` → `[{ id, title, mode, updatedAt }]`
- `GET /api/view/:id` → for `md`: `{ id, mode, html: <marked-rendered>, title, updatedAt }`; for `html`: `{ id, mode, content, title, updatedAt }`. `404` if absent.
- `GET /api/events` → **SSE** (`text/event-stream`). Maintains a subscriber set; on each `render()` push, emits `data: {viewId, updatedAt}\n\n`. Clients re-fetch `/api/view/:id` and re-render.

**Why SSE, not the existing `/ws`:** the render framework must own its client set (the render shell), distinct from any future chat-WS clients; SSE is a purpose-built one-way channel with its own subscribers, fully decoupled from ticket-04's `/ws`. *Alternative considered:* reuse WS `broadcast()` with a new `view_update` frame via the forward-compat `WebFrame` member (zero protocol change) — **rejected for v1** to keep render clients fully decoupled from chat clients; can unify later if a single browser app emerges.

### D4 — Browser shell (vanilla, no build, no framework)
A single HTML document served inline (a string constant, like `web-access`'s `generateCuratorPage`) with embedded CSS + JS — **no React, no Bun.build, no committed `dist/`**. JS:
- on load: `GET /api/views` → render view tabs; select the view from `location.hash` (or default `"main"`).
- `GET /api/view/:id` → render into the content pane: `md` injects the server-rendered HTML; `html` sets an `<iframe sandbox="">` (no `allow-scripts`) `srcdoc` to the content.
- subscribe `GET /api/events` → on a `view_update`, refresh the tabs and re-fetch/re-render the affected view.

### D5 — HTML trust boundary
`html` mode renders inside `<iframe sandbox="">` (no `allow-scripts`, no `allow-same-origin`) via `srcdoc`. This is the trust boundary: agent-generated HTML cannot execute scripts or access the shell/session. No `DOMPurify` dependency. (If inline-script rendering is ever required, that is a future hardened decision, out of scope for v1.)

### D6 — Dependency
Add `marked` (`^15`, matching `pi-agent-ext-wayfind`) to `@repo/pi-agent-ext-webui` deps. Used server-side only (D3 md rendering). No sanitizer dep (D5).

### D7 — URL & port
Served on the webui WebServer's existing ephemeral loopback port (`server.url`). `render()` returns `${server.url}/#${viewId}`. The port is **not** logged today; **actively announcing the URL to the user at `session_start` is deferred to ticket 07** (port/auth/URL-discovery). For v1, `render()` returns the URL in-process and the caller surfaces it (the tool returns it as result text; extensions print it themselves).

### D8 — Decoupling invariants (must hold)
1. The render framework does **not** touch `pi.on("input")`, the mutex, `sendUserMessage`, or the `/ws` chat frames.
2. It is strictly additive: new routes (via `setHttpRoutes`), a new SSE channel, a new registry, a new tool, a new `pi.events` subscription.
3. The only existing-04 behavior changed is `GET /` (stub connect-test → render shell). `/health` and `/ws` are unchanged.

## Testing Decisions
Test external behavior, not internals.
- **Registry** (pure): `render()` creates the default view, replaces on re-render to the same id, `listViews`/`getView` return correct shapes, timestamps advance.
- **Routes** (live, real `WebServer`, reusing `web-server.test.ts` helpers + the `wiring-live-smoke.test.ts` real-server pattern): after `render()`, `GET /api/views` lists the view; `GET /api/view/:id` returns md as rendered HTML and html as raw content; `GET /api/events` SSE delivers a `view_update` on the next `render()`.
- **Tool**: `webui_render.execute()` calls the registry and returns `{ content:[{type:"text",text:<url>}], details:{viewId,url} }`.
- **Event channel**: a fake `pi` host (as in `wiring-live-smoke.test.ts`) — `pi.events.emit("webui:render", {...})` lands in the registry.
- **Decoupling negative control** (mirrors smoke F2): the render path does not invoke `sendUserMessage` or trigger any `mutex_blocked` broadcast.
- **Sandbox**: assert `html`-mode content is delivered for iframe `srcdoc` with a `sandbox` attribute and no `allow-scripts`.
- **Existing-test impact**: `tests/wiring-live-smoke.test.ts` assertion A (currently asserts `GET /` contains "webui connect-test") must be updated — `/` now returns the render shell. This is an expected, in-scope test update.

## Out of Scope (v1)
- Chat / co-drive UI (prompt input, streaming transcript, mutex UI) — the original chat-frontend framing; split out / deferred.
- Dedicated rich renderers per tool type (images/videos/manifests/diffs/trees) — ticket 05. (Images via markdown `![](url)` work only if the URL is reachable from the browser.)
- Auth, port-logging/URL-discovery to the user, random-token — ticket 07.
- Persistence (in-memory only; cleared at session end).
- Multi-session / per-tab session isolation.
- Append/accumulate within a view (v1: replace only).
- Unifying the render shell with a future chat frontend into one browser app.
- Client-side syntax highlighting (marked emits `<pre><code>`; highlighting can be added later).
- Inline-script rendering in `html` mode (sandbox blocks it by design).

## Further Notes
- **Greenfield**: no existing render/view surface to reconcile — only the ticket-04 `STUB_PAGE` at `/`, which this replaces.
- Reuses ticket-04's `WebServer` (Bun.serve, loopback `originAllowed`, ephemeral port) as the HTTP host — no new server process.
- `marked` is already a dep of `pi-agent-ext-wayfind` (`^15`) but workspace-isolated; adding it to webui is a new explicit dep (not transitive).
- The inbound `appexec` command + forward-compat `WebFrame` passthrough (ticket 04) remain available as future seams but are **not** used by v1 render (SSE is used instead, for client-set isolation).
