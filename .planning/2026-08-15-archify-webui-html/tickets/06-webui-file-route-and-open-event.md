---
ticket: 06-webui-file-route-and-open-event
effort: archify-webui-html
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocking: [07, 08]
---
# 06 — webui: file route + `webui:open` event (tracer bullet)

> Vertical slice through the webui half of spec §4.1–4.2 (decisions 01/03/04). Blocking for
> 07 (archify emitter) and 08 (docs/e2e).

## Goal

One webui change-set delivers the whole server-side seam: config → route → CSP → event
handler → notify → tests.

## What to build

1. **Config** (`src/webui-wiring.ts`): `WebuiDeps.fileRoots?: string[]`; env fallback
   `WEBUI_FILE_ROOTS` (`:`-separated); default `[]` (fail closed). Explicit deps win (tests).
2. **File route** (new `src/file-routes.ts`, `OutputRouteHandler` shape): `GET
   /files/<rootIdx>/<rel…>` — leading integer segment parsed+dropped (mirrors `/output/0/`);
   per-request realpath containment (resolve → `realpathSync` both sides →
   `startsWith(root + sep)`); out-of-range idx / escape / non-regular file → uniform 404.
   MIME: `.html` → `text/html; charset=utf-8`; else `application/octet-stream` +
   `X-Content-Type-Options: nosniff`. **CSP on EVERY response**:
   `Content-Security-Policy: sandbox allow-scripts allow-downloads` — verify vendored
   archify export-menu mechanics (blob download / popup) and add `allow-popups` only if
   required; document the verification in a code comment.
3. **Registration order**: after render routes, before output routes in the `setHttpRoutes`
   chain (`webui-wiring.ts:499–506`).
4. **`webui:open` handler** (new `src/open-event-handler.ts`): payload
   `{ path, view?, title? }` on `pi.events`; resolve absolute → same containment validation
   → `ui.notify(\`${title ?? path} — open ${server.url}/files/${rootIdx}/${rel}\`)`;
   invalid/outside-roots → ignore + `console.log` debug, never throw. No shell tab
   (decision 01-A); `view`/`title` are notify-label + forward-compat only.
5. **Tests** (spec §5 webui seams): `file-routes` unit (containment/CSP/MIME/idx routing),
   `open-event-handler` unit (valid/outside/no-roots), config parsing (deps > env > default
   `[]`).

## Acceptance

- An emitted `webui:open` for a file under a configured root yields a servable URL that
  renders full archify HTML **with scripts running** (theme toggle/export menu work).
- Outside-root path → 404 (route) / ignored (handler). Empty roots → nothing served.
- CSP header present on every `/files` response; `.html` never forced to download.

## Gate

`( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`

## Result

implemented — /files route + webui:open + resolveFileRoots; webui gate 423+ pass
