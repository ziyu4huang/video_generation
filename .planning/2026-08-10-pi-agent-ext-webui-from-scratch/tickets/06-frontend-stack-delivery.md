# 06 — Frontend stack & delivery

type: grilling
blocked by: —
status: closed
resolved: 2026-08-11

> **Reframed & spec'd (session decision).** Resolved as a **generic render framework** (not a gui-movie-director clone); stack = vanilla, no-build. See ../specs/06-frontend-render-framework.md + ../plans/06-frontend-render-framework-plan.md.

## Question

What is the web frontend tech stack and delivery model — React (matching `gui-movie-director`'s Bun+React) vs Vanilla/lit; assets built-in to the extension vs separate build; bundled into the package vs served from a sibling dir?

## Context (gui-movie-director is the proven template)

- `bun-apps/gui-movie-director` is the only `Bun.serve`+React site in this repo and the direct template: `Bun.build({ entrypoints:[frontend/app.tsx], outdir, target:"browser", minify:false, splitting:false, sourcemap:"external" })` — **no vite, no committed `dist/`**; built at first start, cached on `globalThis` for `--hot` survival; served at `/frontend/bundle.js`+`.css` with ETag/304; SPA shell `frontend/index.html` as fallback.
- web-access shows the other end: **100% inline HTML generation** (`generateCuratorPage` returns one self-contained HTML string with inlined CSS/JS + `__INLINE_DATA__` bootstrap) — no build step at all. A viable minimal-MVP option if React is overkill.
- webui is an EXTENSION (lifecycle from `session_start`), not a top-level `server.ts` like gui-movie-director — so the build-at-start glue moves into the extension's `session_start` (or commit `dist/` and serve statically).
- Delivery options: (a) build the frontend, commit `dist/` into the extension package, serve via the extension's `Bun.serve`; (b) `Bun.build` at first `session_start` (no committed dist, like gui-movie-director); (c) inline-HTML (like web-access) for a minimal first cut.
- Align with 04's protocol and 07's URL discovery. Unblocked — can run in parallel with 03/04.

## What resolving looks like

A grilling decision on stack + delivery, with a note on reuse from `gui-movie-director`. For minimal MVP, inline-HTML or a tiny Bun.build React shell are both defensible.
