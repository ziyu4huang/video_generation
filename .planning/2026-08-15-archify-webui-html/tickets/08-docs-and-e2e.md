---
ticket: 08-docs-and-e2e
effort: archify-webui-html
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocking: []
note: blocked-by: 06, 07 (ships last, verifies the whole seam)
---
# 08 — Docs + cross-package smoke + map sync

> Closing ticket (spec §4.4 registration unchanged; this verifies docs + the seam end to
> end).

## Goal

Documentation truthful for both packages; one cross-package smoke proving the
render→emit→serve→open chain; planning map synced.

## What to build

1. **webui README**: the `/files/<rootIdx>/<rel>` route, the `webui:open` event (payload +
   open-to-notify behavior), `WEBUI_FILE_ROOTS` env / `fileRoots` dep, and a security note
   (CSP `sandbox allow-scripts` opaque origin, realpath containment, fail-closed empty
   roots).
2. **archify README**: post-render optional `webui:open` emit — webui-optional (no
   dependency; absent webui → unchanged headless behavior, path in tool result).
3. **Cross-package smoke** (manual steps in the ticket PR, or `PI_AGENT_E2E`-gated test):
   configure `WEBUI_FILE_ROOTS` → run `archify_render` → assert `ui.notify` URL →
   `curl`/browser-check the URL serves full HTML with the CSP header.
4. **map.md sync**: tickets 06–08 → done; effort status → done (or archived) per
   conventions.

## Acceptance

- Docs truthful: a reader can configure roots and predict route/notify behavior from README
  alone.
- Smoke passes (or is recorded as manual-run evidence); both packages' gates green.

## Gate

`( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )` AND
`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun test --isolate )`

## Result

implemented — READMEs updated both packages; manual smoke steps documented in webui README §files; review approve-with-fixes applied — URL encoding + nits
