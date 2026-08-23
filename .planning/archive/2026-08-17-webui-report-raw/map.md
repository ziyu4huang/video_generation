# webui-report-raw — unblock exports + standalone report door

status: done

## Why

User: PNG/SVG export in archify report diagrams did nothing (even in
fullscreen); the report scrollbar sits far from the browser edge. Root cause:
the report iframe sandbox was allow-scripts WITHOUT allow-downloads — Chromium
silently blocks a[download]/blob exports (fullscreen changes presentation,
not sandbox flags). The /files route already ships CSP sandbox allow-scripts
allow-downloads for exactly this reason. Scroll: the app-shell (overflow
hidden) + pane scroll + iframe internal scroll nest three scroll regions —
the visible bar is two insets from the edge.

## What (PR #1583)

- render-shell: report iframe sandbox -> "allow-scripts allow-downloads"
  (mirrors /files; still NO allow-same-origin).
- GET /api/report/<id>/raw: serves a stored frame's html top-level with the
  /files CSP (native edge scrolling, working export menus). Loopback,
  origin-guarded chain; 404 markdown-only/unknown ids.
- "open standalone" button on every html report article (parent window.open —
  no sandbox constraint).
- wiring passes getReport (session-store snapshot transcript lookup).
- guards in tab-views.test.ts.

## Verification

webui suite 0 fail; template parse guard; live manual: export PNG in-tab and
standalone after the user restarts pi.
