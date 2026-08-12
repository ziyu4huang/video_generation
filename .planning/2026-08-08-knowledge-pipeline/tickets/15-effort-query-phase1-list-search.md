---
type: build
status: closed
claimed:
blocked by: none (Phase 1 is standalone — reads .planning directly, no card-store/embed dependency)
unblocks: effort-query Phase 2 (full planning-card pipeline = tickets 08/09/10)
---
# 15 — Effort-query Phase 1: lightweight list + search

> UNBLOCKED. Phase 1 of the phased effort-query scope decision (2026-08-09 grill). Phase 2 = tickets 08/09/10 (full planning-card pipeline), unchanged.

## Goal
Deliver a lightweight, dependency-free effort-query capability: cross-effort `list` + `search` over `.planning/`, answering "what efforts exist" and "find tickets/decisions about X across efforts." Read-only; no card-store, no embed, no sync. (Phase 2 = full planning-card pipeline, tickets 08/09/10.)

## Design (Phase 1 — grill, accepted 2026-08-09)
1. Surface — extend `wayfind_effort` with `list` + `search` actions (`effort` param optional for these). No new tool/manifest entry; wayfind owns .planning semantics.
2. Search ranking — in-memory scored keyword match (term-frequency + frontmatter boost: title/tags/Resolution weighted higher). No DB, no embed. (FTS5/embed = Phase 2 upgrades.)
3. Content scope — tickets (frontmatter + body, incl. closed-ticket Resolution/Decisions) + map.md (Destination, Decisions-so-far, Notes). Decisions queryable, not just open tickets.
4. Output — `search`: ranked top-K {effort, ticket-id, title, status, type, snippet, score} with filters --effort/--status/--type. `list`: per-effort {slug, status, ticket-counts, frontier-size, fog, last-modified}.
5. Read-only — Phase 1 never writes; git canonical. CRUD/sync/staleness = Phase 2 (09/10).

## Tracer-bullet tasks (blocking edges in order)
- T1 — `list` action: readdir .planning; per-effort readMap/readEffortMeta -> aggregate {slug, status, ticket-counts, frontier, fog, last-modified}. Reuse existing parsers (parseTicketFile, readMap, readEffortMeta, activeEffort in coordinator.ts). [blocks T3]
- T2 — `search` action: parse all efforts' tickets + map.md into an in-memory index; scored keyword match (TF + frontmatter boost); structured filters (--effort/--status/--type); ranked top-K with snippets. [blocks T3]
- T3 — Wire list/search into the `wayfind_effort` tool schema (effort optional for these actions); update extensions/<wayfind> registration/tests if needed.
- T4 — Tests: list returns all efforts with correct state; search ranks a known ticket #1 for its keyword (e.g. "surrealdb" -> tickets 04/14); filters (--status/--type) work; read-only (no .planning writes).

## Verification
- `wayfind_effort list` enumerates all efforts under .planning/ with accurate status/ticket-counts.
- `wayfind_effort search "surrealdb"` returns the Round-2 embed tickets (04/14) ranked highly across efforts.
- `--status closed --type grilling` filters correctly.
- No mutation of .planning (read-only verified).
- `( cd bun-apps/pi-agent-ext-wayfind && bun run typecheck && bun test )` green.

## Out of scope (Phase 2 — tickets 08/09/10)
- planning-ticket card kind + serializer + card-store integration (08).
- semantic search via embed (rides the Round-2 SurrealDB/lazy-backfill track).
- DB<->md sync (09), staleness/dependency graph (10), dedup/conflict detection.
- Mutation/CRUD (create/update/close via pipeline).

## Resolution

Shipped — 15-Phase1 via #1168 (squash 48df0b1a).
