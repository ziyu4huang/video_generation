## Question
Which files/modules across the four packages are dead or near-dead? Verify each suspect with import graph + test coverage + git log — CITE or ACQUIT every one (ticket-09 lesson: verify "dead code" claims before deleting — serializer/trigger were live). Suspects (non-exhaustive): zk loop.ts / merge.ts / task-builders.ts / card-render.ts; hermes review-memory-ops.ts / session-anchor-search.ts / constants.ts hotspots; obsidian's ~17 fat-tool actions reachability.
type: research
blocked by: (none)
