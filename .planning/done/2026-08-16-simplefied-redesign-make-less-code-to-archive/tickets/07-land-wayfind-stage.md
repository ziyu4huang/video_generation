---
type: grilling
blocking: 4
---

## Question

Wayfind skill cuts landed at zero (ticket 04: 0/16 KEEP), so this ticket re-scopes to the src side. Probe then ratify wayfind src trims — effort-query.ts (354L), architecture-render.ts (329L), stale-seam surfaces, README staleness (says 6 skills; 22 ship) — against the trio budget (Δtrio ≤ −400 vs ticket-01 snapshot). Small ratified trims land here; anything big becomes its own landing ticket. Output: ratified trim list + Δwayfind number.

## Resolution

Landed 2026-08-21 (effort 2026-08-21-harness-streamline, phases W1–W4; PR branch feat/wayfind-w1-deps-dead-exports). Ratified trims, all gates green (biome check + tsc + 469 tests / 0 fail):

- **W1 deps + dead exports**: dropped unused `marked` (dep) + `@playwright/test` (devDep); deleted the src/index.ts re-export block (kept `SharedStatusWidget`/`readSharedStatusWidget` for the seam-contract SHAPE guard); moved test-only `resolveTicket`/`addTicket` → tests/helpers/effort-fixtures.ts; README truth pass (16 skills incl. ask-matt, count-agnostic test claim, statusbar/help rows added).
- **W2 status pipeline merge**: DELETED `StatusReport`/`statusReport()`/`renderStatus()` from src/wayfinder.ts — `/wayfind status` + bare-`/wayfind` fallback now use the ONE pipeline (effort-tool.ts `effortStatus` + effort-render.ts `renderStatus`); the renderer gained the richer empty-frontier hints the /wayfind path owned ("blocked or claimed" / "the way is found" + `/wayfind done` nudge).
- **W3 scaffolder unification**: new `writeFreshMap()` in src/map.ts is the single fresh-map constructor; `createEffort` = existence-guard + writeFreshMap; `chartMap` = preserve-rewrite else writeFreshMap (legacy prose-only re-chart stays front-matter-free). Byte-equality test added.
- **W4 frontier bug fix**: `listEfforts` frontierSize now `computeFrontier(tickets).length` — one frontier definition everywhere; regression test (closed blocker → dependent counts).

Δwayfind src (this branch): −166/+70 = **net −96** (relocations to tests/ excluded). Trio budget vs ticket-01 snapshot: 3,721 + 419 + 6,120 = 10,260 vs 11,979 → **Δtrio = −1,719 ≤ −400** ✅ (subagent stage's landed cuts carry most of it). architecture-render.ts noted in the Question was already relocated to archify before this ticket ran (see map "Moved out").

closed: (landed)
