## Question

claimed: resume-08-session

Owner-declare `gating` on every tool belonging to `movie-director` (`bun-apps/pi-agent-ext-movie-director/extensions/movie-director.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: movie, movie_help). Then remove `movie-director`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `movie-director` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

type: task
blocked by: 01, 02

## Resolution

Owner-declared `gating` (keywords-only, mirroring the GATES entry which had no `requires`) added to both `movie` and `movie_help` (byte-identical → `reconstructOwnerDeclaredGates` collapses them into one multi-name gate `{names:["movie","movie_help"]}`, preserving co-fire per ticket 01). Removed the movie GATES entry from hardcoded `GATES` (movie not in CORE_TOOLS — no change). Added `movie-director` to `MIGRATED_EXTENSIONS` (registrar default export). `qa/evaluate.ts` `reconstructOwnerDeclaredGates` now includes `movieDefault`; l2/savings auto-include via CORPUS_GATES (no edits). `tool-gate.test.ts` adapted (`captureOwner(movieExtension)`, dormant stand-ins movie→workflow); `coverage.test.ts` + `self-promotion-interaction.test.ts` fixtures updated. movie-director has no session_start handler (n/a). Tests: tool-gate 257/0, movie-director 833 pass/8 skip/0 fail, schema-cost canary 17/0. enable_tool NAME-mode sibling co-activation gap noted in comments, NOT fixed (cross-cutting, tracked in map). Commit: 9f432979.

status: closed
