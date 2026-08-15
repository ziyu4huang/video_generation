# Spec — archify–webui HTML: full-fidelity diagram serving + `webui:open`

> STATUS: drafted 2026-08-16. Frontier cleared (decisions 01–04 closed); build tickets
> `tickets/06`–`08`. Evidence: `map.md` Context (researched at this effort's spawn), verified
> against `bun-apps/pi-agent-ext-webui/src/{webui-wiring,output-routes,render-routes}.ts` and
> `bun-apps/pi-agent-ext-archify/extensions/archify.ts` on 2026-08-16.

## §1 Goal

Serve archify's generated HTML diagrams **full-fidelity** (inline SVG + JS runtime: theme
toggle, semantic nav, PNG/SVG/WebM export) over the webui loopback server, and announce a
clickable URL in the TUI after each successful render — with archify remaining **webui-free**
(no dependency; optional emit, no-op when webui is absent).

## §2 Background

- **archify** (`bun-apps/pi-agent-ext-archify`) renders typed JSON IR → self-contained HTML
  (vendored archify@2.12.0). Tools: `archify_render` / `archify_validate` / `archify_delta`.
  Output path = `outputPath` param → `ir.meta.output` → `<cwd>/<type>.html`; today surfaced
  only as tool-result text (headless by design). Extension entry `extensions/archify.ts` is a
  thin factory registering the three tools.
- **webui v2** (`bun-apps/pi-agent-ext-webui`): loopback `Bun.serve` + WS/SSE shell. The
  existing `webui:render` event renders md/html views inside `<iframe sandbox="">` (NO
  scripts), and the `/output` static route (`src/output-routes.ts`) deliberately MIME-blocks
  `.html`/`.svg` (octet-stream + `nosniff` → forced download) with realpath containment.
  `wireWebui(pi, deps?)` (`src/webui-wiring.ts`) composes everything; HTTP routes are an
  additive seam (`WebServer.setHttpRoutes`, consulted in `fetch()`); route order at
  `webui-wiring.ts:499–506` = render routes, then output routes. Events ride the shared
  `pi.events` bus (any extension may emit — wayfind precedent `src/effort-tool.ts`).

## §3 Decisions

1. **01 transport = A — full-fidelity file route.** webui serves full HTML via a new file
   route, opened as a **top-level browser tab** (scripts allowed). Archify's JS runtime
   (theme/nav/export) is the product; a static-SVG view would gut it.
2. **02 emitter = generic webui seam.** webui owns a new **`webui:open` event** + the file
   route; archify emits optionally post-render via `events?.emit` (wayfind effort-tool
   precedent). No webui → no-op, path printed in the tool result as today. String-literal
   channel contract; **no archify→webui dependency**.
3. **03 script policy = CSP `sandbox allow-scripts` (+ `allow-downloads` / `allow-popups`
   only if vendored export code needs them — implementer verifies) + configured directory
   allowlist** (`fileRoots` option → env `WEBUI_FILE_ROOTS`, `:`-separated; **fail closed**:
   empty roots = route serves nothing). Served HTML gets an opaque origin → cannot
   same-origin-call `/api` or WS. realpath containment reused from the `/output` pattern.
4. **04 view identity = IR output basename sans extension.** Re-render replaces the same
   view; delta compare → `compare-<basename>`; title = `ir.meta.title ?? diagramType`;
   informs the `ui.notify` label + forward-compat with future shell tabs. **No shell tab
   today** (01-A = top-level document).

## §4 Design

### 4.1 webui file route

`GET /files/<rootIdx>/<rel…>` in a new `src/file-routes.ts` (same handler shape as
`createOutputRoutes` — `OutputRouteHandler`-style, DI options for tests):

- **rootIdx**: indexes the configured roots array. The leading integer segment is parsed and
  dropped, exactly mirroring `/output/0/`'s convention in `output-routes.ts` (leading
  `{int}/` parsed + dropped). Out-of-range idx (including non-integer / missing) → uniform 404.
- **Containment** (per request): resolve the joined path → `realpathSync` both sides →
  `startsWith(root + sep)` (the TRAILING-separator rule from `output-routes.ts`). Escape
  attempts, symlink hops, non-regular files → the same uniform 404 that never leaks existence.
- **MIME**: `.html` → `text/html; charset=utf-8`; everything else →
  `application/octet-stream` + `X-Content-Type-Options: nosniff` on every response.
- **CSP header on EVERY `/files` response**: `Content-Security-Policy: sandbox allow-scripts
  allow-downloads`. Implementer: verify the vendored archify export-menu mechanics (blob
  download / popup) in `bun-apps/pi-agent-ext-archify/vendored/` and add `allow-popups` ONLY
  if required; document the verification in a code comment at the header site. Opaque origin
  means the served page can never same-origin-call `/api` or the WS endpoint.
- **Config**: `wireWebui(pi, { fileRoots: string[] })` → also readable from env
  `WEBUI_FILE_ROOTS` (`:`-separated; explicit `deps.fileRoots` wins for tests). Default `[]`
  = **fail closed** (route registered but serves nothing but 404s).
- **Registration order**: consulted AFTER render routes, BEFORE output routes in the
  `setHttpRoutes` chain (`webui-wiring.ts:499–506` — insert `fileRoutes` between the two).

### 4.2 `webui:open` event handler

New `src/open-event-handler.ts`, wired in `wireWebui` like the render/present handlers:

- **Payload**: `{ path: string; view?: string; title?: string }` on the `pi.events` bus —
  any extension may emit (bus is a shared channel; webui does not own emitters).
- **Handler**: resolve `path` to absolute → validate against the configured roots (the SAME
  containment check as 4.1) → `url = ${server.url}/files/${rootIdx}/${rel}` →
  `ui.notify(\`${title ?? path} — open ${url}\`)`.
- **Invalid / outside-roots path** → ignore + `console.log` debug line. **Never throw** —
  pi.events bus robustness rule (a bad emitter must not take down the host).
- **NO shell tab / view creation** (top-level document, decision 01-A). `view`/`title` are
  notify-label + forward-compat payload fields only (ticket 04).

### 4.3 archify emitter

`extensions/archify.ts` factory captures `pi.events`. After `archify_render` success AND
after `archify_delta` success:

- `events?.emit("webui:open", { path: outPath, view: <basename sans extension>, title:
  ir.meta.title ?? diagramType })` — delta view = `compare-<basename>` (ticket 04).
- Webui absent → `events` is undefined or the event has no listener → no-op (the path is
  already returned in the tool result as today; zero behavior change).
- The channel is a **string-literal event contract** (like wayfind): archify imports nothing
  from webui; the payload shape is pinned by an archify-side test (cross-package contract).

### 4.4 Registration

Unchanged: webui stays static (`bun-apps/pi-agent/src/static-extensions.ts`), archify stays
dynamic (`run-dir/manifest.json` `extensions[]`). No manifest/static changes in this effort.

## §5 Test seams (MUST ship as named tests)

- **webui** (`bun-apps/pi-agent-ext-webui`):
  - `file-routes` unit: containment (in-root ok; `..` escape, symlink hop, out-of-range /
    non-integer rootIdx, non-regular file → uniform 404), CSP header on every response, MIME
    (`.html` vs octet-stream + nosniff), rootIdx routing across multiple roots.
  - `open-event-handler` unit: valid path → notify with `${server.url}/files/<idx>/<rel>`;
    outside-roots → ignored (no throw, debug log); empty roots → ignored.
  - config parsing: `deps.fileRoots` beats env; `WEBUI_FILE_ROOTS` `:`-split; default `[]`.
- **archify** (`bun-apps/pi-agent-ext-archify`):
  - emitter fires on `archify_render` success and on `archify_delta` success via a **mock
    event bus**; payload naming per ticket 04 (basename sans ext; `compare-` prefix; title
    fallback chain).
  - **no-bus no-op**: factory without `events` → no throw, tool result unchanged.
  - **cross-package contract pinned**: payload shape asserted as a literal
    `{ path, view, title }` (webui handler consumes exactly this).

## §6 Out of scope

- Ticket 05 (HITL Approve/Regenerate/Tweak loop via `webui:present`) — fog/deferred.
- Shell tabs for HTML views (top-level document only; `view` is forward-compat).
- PPTX/deck surfaces; delta-compare UI beyond naming.
- URL accessor beyond this route (no general file-browsing API).
- Programmatic port API (`WebServer.url` stays private).
