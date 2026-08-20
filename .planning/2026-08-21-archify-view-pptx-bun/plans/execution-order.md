# Execution order — archify-view-pptx-bun

Five phases. Each ends at a green gate on both packages; nothing merges half-built.

## Phase 0 — prerequisite

`bun install` from `bun-apps/` (no `node_modules` present at effort start). Confirm
`bun --version` is 1.4.x — the whole design depends on it.

## Phase 1 — the ShapeIR seam  (tickets 01, 02, 03)

01 and 02 are independent and can go in parallel; 03 needs both. Exit criterion: golden
ShapeIR fixtures committed for all five diagram types. Nothing user-visible changes yet —
this phase exists so phases 2 and 4 are cheap.

## Phase 2 — native-shape PPTX  (tickets 04, 05, 06)

Strictly sequential. **06 is the phase gate**: `<a:blip> === 0` across all five types. The
browser leaves the PPTX path in 05; do not remove the `playwright` devDep until 11, so that a
mid-phase bisect still has a working comparison.

## Phase 3 — the Diagram pane  (tickets 07, 08)

Independent of phases 1–2 — could run in parallel with them if two people are on this.
07 (server seam) then 08 (shell). Exit criterion: an `archify_render` lands in the pane with
its runtime intact, and survives a refresh.

## Phase 4 — one manifest, two surfaces  (ticket 09, then 10)

09 joins phases 2 and 3 and is where the effort's premise pays off: the deck you preview is
the deck you export. 10 (thumbnails) is optional polish — ship 09 without it if time is short.

## Phase 5 — Bun-native + guards  (tickets 11, 12)

11 removes Playwright; 12 makes removal permanent and syncs the docs + `map.md`.

## Deferred

13 (`Bun.markdown`) is fog. Do not start it inside this effort.
