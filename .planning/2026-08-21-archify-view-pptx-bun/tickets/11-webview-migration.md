---
ticket: 11-webview-migration
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
blocks-on: [05]
blocking: [12]
---
# 11 — archify: mermaid test → `Bun.WebView`; drop `playwright`

> Spec §4.6. Decision D5.

## Why this is not a trade

`Bun.WebView` was probed on this machine: 356 ms cold, `navigate` / `evaluate` /
`screenshot` all work headless, macOS uses the system WebKit so **nothing installs**.
The mermaid test therefore keeps executing a real engine — coverage is preserved, and the
`playwright` devDep plus the chromium download both go away.

## What to build

1. Rewrite `__tests__/architecture-mermaid.test.ts` on `Bun.WebView`: navigate the rendered
   report's `file://` URL, `evaluate` that mermaid produced an `<svg>` with non-zero
   dimensions, optionally `screenshot()` as a smoke artifact.
2. Replace the `chromium.executablePath()` skip-gate — the browser precondition no longer
   exists. If a skip remains it must be for a NEW measured reason, stated in the file
   (see the repo's history of skip-gates copied without their cost rationale).
3. Remove `playwright` from `bun-apps/pi-agent-ext-archify/package.json` `devDependencies`;
   confirm `scripts/deck.ts` no longer imports it (ticket 05 did the removal).
4. Re-run `bun install` from `bun-apps/` and commit the `bun.lock` change.

## Acceptance

- `bun run test` in the archify package passes with **no** Playwright browsers installed.
- `grep -r playwright` in the package returns nothing outside `.planning`/docs prose.

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )`
