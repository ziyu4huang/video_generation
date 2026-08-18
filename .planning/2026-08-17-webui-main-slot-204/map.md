# webui-main-slot-204 — kill the boot-probe console noise

status: done

## Why

The shell probes GET /api/view/main at boot. With no main view (the normal
clean-boot state) the route answered 404 — Chromium logs every 404 fetch as a
console error, so the power-tool webui audit invariant zero-console-errors
could NEVER pass on a clean boot (both the live audit and the e2e stub probe
showed 2x "Failed to load resource: 404" traced to this exact URL).

## What (PR #1592)

- render-routes.ts: missing view + id === "main" -> 204 No Content (an empty
  main slot is a normal state, not a missing resource); every other missing id
  keeps the true 404.
- render-shell.ts: <link rel="icon" href="data:,"> kills the favicon request (the OTHER clean-boot 404 — Chromium strips the URL from the console text but msg.location() shows favicon.ico); renderView handles 204 BEFORE res.json() (a 204 has no
  body; parsing it would throw) — clears the surface and returns.
- tests: view/main miss -> 204; view/other miss -> 404 (route-level).

## Verification

webui suite 0 fail; e2e stub re-probe: zero console errors; webui audit tool
zero-console-errors PASS on a clean boot.
