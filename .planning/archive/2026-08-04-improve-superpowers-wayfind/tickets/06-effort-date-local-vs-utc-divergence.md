---
type: task
status: closed
resolution: "Fixed + merged via PR #1034 (mergeCommit f7bef094) — datePrefix() and today() (manifest created/last) unified on one local source via today(now) with a now-clock seam; effortSlug date === readMap(...).meta.created; 8 UTC-anchored test assertions updated; suite 263/0 green under UTC/NY/Tokyo"
---
# Effort folder date (local) and manifest created/last (UTC) diverge

## Question

`effortSlug` / `datePrefix` (`src/wayfinder.ts`) use local `getFullYear/getMonth/getDate`; `today()` (`src/map.ts`, used for manifest `created`/`last`) uses UTC (`toISOString().slice(0,10)`). Verified live: an effort's folder prefix can read `2026-08-05` while its manifest `created` reads `2026-08-04`. So evening-hours-west-of-UTC efforts get a folder named tomorrow but a manifest dated today — folder sort order disagrees with the manifest, and `validateEffortMap` doesn't check dates so it's invisible.

Resolve: route both through ONE date function (reuse `today()` inside `effortSlug`, or make `datePrefix` UTC) and add a test pinning `effortSlug(foo)`'s date component == `readMap(cwd, effortSlug(foo)).meta.created`.
