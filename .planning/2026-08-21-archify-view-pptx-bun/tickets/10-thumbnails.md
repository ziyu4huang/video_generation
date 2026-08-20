---
ticket: 10-thumbnails
effort: archify-view-pptx-bun
type: task
status: closed
created: 2026-08-21
blocks-on: [08]
---
# 10 — webui: slide-rail thumbnails via `Bun.WebView` + `Bun.Image`

> Spec §4.5 step 2 completion. Lowest-priority ticket in the effort — the pane is fully
> usable with a title-only rail.

## What to build

1. Generate one thumbnail per deck slide: `Bun.WebView` (measured: 356 ms cold, headless,
   nothing to install) navigates the slide's `file://` path and `screenshot()`s it; downscale
   and encode with `Bun.Image` (`.resize(…, {fit:"inside"}).webp({quality})`).
2. Cache by `(path, mtime)` under the webui session dir; serve from the existing route
   surface. Generation is **best-effort and off the critical path** — a failure leaves the
   title-only rail, never blocks the pane.

## Acceptance

- Rail shows thumbnails when generation succeeds and titles when it does not.
- Thumbnail generation failure never breaks pane render (test with a WebView stub that throws).
- No thumbnail work happens when the pane has never been opened.

## Gate

`( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun run test )`

## Result

**closed 2026-08-21** — `lib/thumbnails.ts`, a `thumbnails` option through `deck-build` /
CLI / tool, `thumb` → `thumbUrl` resolution in webui's deck handler, image chips in the shell
rail. Tests: `__tests__/thumbnails.test.ts` (9) plus 4 handler + 3 shell tests.

**Placement decision the ticket got backwards.** It proposed generating thumbnails IN webui.
That would have given webui a runtime rendering dependency it does not currently have — for a
visual nicety. Generation lives in archify instead: it already owns the slide files, the
images land beside them, and the `webui:deck` payload just names them. webui serves them over
the `/files` route it already has — no new route, no engine, no new security surface. The
thumb path is validated through the SAME containment core as the slide, and an unservable
thumbnail drops silently rather than costing the slide.

**Cheaper than estimated.** Measured: the five-slide example deck built its slides AND all
five thumbnails in **1.3 s total**, because the engine starts once and is reused. The
module's original "several seconds" estimate was corrected to the measurement. Still opt-in
(`--thumbnails` / `thumbnails: true`) — it is wasted work when you only want a .pptx.

Verified live: all 5 rail chips rendered their images (`naturalWidth` 480) in the shell
alongside the interactive artifact.
