# 06 — Frontend stack & delivery

type: grilling
blocked by: —
status: open

## Question

What is the **web frontend tech stack and delivery model** — React (matching `gui-movie-director`'s Bun+React) vs Vanilla/lit; assets built-in to the extension vs separate build; bundled into the package vs served from a sibling dir?

## Context

- `gui-movie-director` already uses Bun + React — reuse vs divergence is a real choice (shared components? shared port-discovery pattern via `gui:port`?).
- Delivery options: (a) build the frontend, commit `dist/` into the extension package, serve via the extension's `Bun.serve`; (b) keep frontend in a sibling dir, dev-serve separately.
- Must align with 04's protocol and 07's URL discovery. This ticket is unblocked and can run in parallel with the architecture track.

## What resolving looks like

A grilling decision on stack + delivery, with a note on reuse from `gui-movie-director`.
