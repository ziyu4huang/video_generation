## Question

Owner-declare `gating` on every tool belonging to `movie-director` (`bun-apps/pi-agent-ext-movie-director/extensions/movie-director.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: movie, movie_help). Then remove `movie-director`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `movie-director` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02
