---
ticket: 10-thumbnails
effort: archify-view-pptx-bun
type: task
status: open
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
