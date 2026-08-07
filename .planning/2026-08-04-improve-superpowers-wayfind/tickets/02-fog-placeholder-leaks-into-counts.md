---
type: task
status: closed
resolution: "Fixed + merged via PR #1032 (mergeCommit 2cb3b1ea) — new parseBulletList() helper strips <!-- none --> placeholder on read, applied to fog + outOfScope; +2 tests, suite 262/0"
---
# Empty-fog placeholder leaks into status counts (fog 1)

## Question

`writeMap` (`src/map.ts`) emits `<!-- none -->` for empty fog/outOfScope sections; `readMap` parses it back as a real bullet (`fog = ["<!-- none -->"]`). So `statusReport` / `renderStatus` / the overlay all report `fog 1` for *every* freshly-charted effort — verified: a just-charted effort prints `fog 1`. (`closeEffortReflection` already filters `!p.startsWith("<!--")`, proving the team knows the placeholder leaks — but the status path doesn't.) Same defect hits `outOfScope`.

Resolve: strip `<!-- … -->` lines in `readMap`'s fog/outOfScope parsers (or drop the placeholder and render empty inline), and add an fs test asserting `statusReport(cwd, effort).fog === 0` right after `chartMap`.
