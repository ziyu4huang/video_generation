# Knowledge-pipeline Phase 2 — planning-cards, sync, staleness (Design)

**Status:** Design — synthesized from the Phase-2 grill (2026-08-09; tickets 08/09/10 resolved).
**Effort:** `.planning/2026-08-08-knowledge-pipeline/`
**Build track:** 08-impl (planning-card serializer + card-store tenant) → 09-impl (sync layer) → 10-impl (staleness dependency graph).

## 1. Context
The knowledge pipeline self-applies to wayfinder's own `.planning/<effort>/` for CRUD/query/duplicate/conflict/staleness. Phase 1 (ticket 15, shipped PR #1168) delivered read-only `list` + `search` over `.planning/` with no storage. Phase 2 makes `.planning/` a first-class tenant of the card-store: planning-cards are modeled, mirrored to the DB, kept in sync with git-canonical md, and monitored for staleness via a source-dependency graph.

## 2. Prior decisions this builds on
- **Ticket 01** — Unified `Card { id, kind, content, frontmatter, embed?, graph? }`; hermes store is kind-agnostic via a pluggable serializer; single dedup call-site.
- **Ticket 03** — Two-layer graph: wiki-link layer (shared-tag scoreOverlap) + typed entity-relation layer (md-frontmatter `relations:` source-of-truth + derived DB index).
- **Ticket 04** — Embed = nomic-embed-text-v1.5 (768-dim) via LM Studio; consolidate to SurrealDB HNSW (drop sqlite-vec); lazy + background-backfill index build.
- **Ticket 05** — 3-tier drift: Tier-1 md-canonical (md wins, re-index), Tier-2 derived cache, Tier-3 DB-authoritative opt-in.
- **Ticket 06** — Hermes-as-spine: hermes owns `walkAndIngest` + all store writes; calls zk primitives via the typed `KnowledgePipeline` interface in `@repo/pi-agent-ext-core-interface`.

## 3. Design (from grill 08/09/10)

### 3.1 Planning-card model (ticket 08)
- **Ownership/integration:** Hermes owns ingest + store (`walkAndIngest` ingests `.planning/`; card-store mirrors it); a planning-card serializer plugs into hermes (kind-agnostic per ticket 01). Wayfinder stays the semantic owner of the planning domain and consumes the store as a CRUD/query/dedup client.
- **Card kinds:**
  - `kind=planning-effort` — one per `map.md`. `content` = the map body (Destination, Decisions-so-far, Notes, etc.); `frontmatter` = effort slug, status, owner, created/last; `graph` = wiki-links to its tickets.
  - `kind=planning-ticket` — one per `tickets/NN.md`. `content` = ticket body incl. `## Resolution`; `frontmatter` = id, slug, type, claimed, blocked-by, status, **resolution-gist** (one-line gist of the resolution for query/conflict); `graph` = blocked-by edges + cited-source-path edges.
- **Decisions are INLINE** on the ticket-card (resolution-gist frontmatter + full Resolution in content) — queryable via search (Phase-1 list/search + future). First-class `planning-decision` cards are DEFERRED.
- **Storage namespace:** Same SurrealDB/SQLite as knowledge-cards, in a separate table/graph-namespace (kind-prefix or namespace field). Single store (consistent with ticket 04 consolidation).

### 3.2 `.planning` DB↔md sync (ticket 09)
- **Canonicality:** `.planning/` md is git-canonical; the DB mirrors it for acceleration.
- **Sync trigger:** On-demand refresh + background backfill. The card-store refreshes lazily when a query/CRUD hits stale data (content-hash check); a background sweep backfills changed files. No git hooks (robust across worktrees/agent edits; matches ticket 04's lazy + backfill).
- **Multi-worktree merge:** Git resolves the md (canonical); re-ingest detects the content-hash change and re-mirrors; conflict markers in the md → flag the effort for human review.
- **Drift:** `.planning` is a Tier-1 instance of ticket 05 (md wins; content-hash drift detection; re-ingest on drift). No special-casing.

### 3.3 Staleness via source-dependency graph (ticket 10)
- **Dependency edges (v1, auto-inferred):**
  - ticket→ticket `blocked-by` (from ticket frontmatter).
  - decision→source-file (paths cited in the Resolution body, e.g. `bun-apps/...`, `src/...`).
  - Optional explicit `depends_on: [paths]` frontmatter for manual additions/overrides.
  - Effort-level relations (Supersedes/Absorbed-by/Covered-by/Shares-decision-with) DEFERRED.
- **Re-validation:** On-access content-hash check — when a decision/card is queried or an effort's graduation is evaluated, compare each dep's current content-hash to its last-validated hash; background sweep flags stale. Same on-demand shape as sync.
- **Surfacing & action:** `stale:` flag on the card + `stale:` query; block an effort's graduation while it has stale decisions; agent re-grills to resolve (re-open ticket, re-validate, update resolution). Human/agent gates the re-grill.

### 3.4 Conflict detection (ticket 08 Q4)
Heuristic — flag pairs of CLOSED planning-ticket cards that share scope (tag/effort/topic overlap, or a cited source path) but have DIVERGENT `resolution-gist`. Surfaced as a `conflict:` query/flag. Reuses the graph (tickets 03/10); no first-class decision entities required.

## 4. How the pieces compose
`walkAndIngest` (hermes, ticket 06) walks `.planning/`; the planning-card serializer emits `planning-effort` + `planning-ticket` cards into the namespaced card-store tenant (08). The store's on-demand + backfill sync keeps the mirror aligned with git via content-hash (09). The dependency graph (blocked-by + cited paths) feeds staleness re-validation on-access + via sweep, surfacing `stale:` / `conflict:` and gating graduation (10). Wayfinder consumes all of this as a client for its `list` / `search` / CRUD / conflict / staleness surface.

## 5. Build track
- **08-impl** — planning-card serializer (`map.md` → planning-effort; `tickets/NN` → planning-ticket with resolution-gist extraction); card-store planning tenant (namespaced table); wire into hermes `walkAndIngest` for `.planning/` as a source. Unblocks 09/10.
- **09-impl** — content-hash staleness check + on-demand refresh + background backfill; multi-worktree merge handling (re-mirror + conflict-marker flag); Tier-1 drift re-ingest.
- **10-impl** — dependency-graph build (blocked-by + cited-path auto-inference + optional `depends_on`); on-access + sweep re-validation; `stale:` / `conflict:` query/flag; graduation gate.

## 6. Out of scope (Phase 2 v1) — rejected/deferred options
- First-class `planning-decision` cards (deferred; escalate only if 10-impl can't key off ticket-cards).
- Effort-level relations (Supersedes/Absorbed-by/Covered-by/Shares-decision-with).
- Write-through sync; git-hook-triggered sync; event-driven staleness.
- Dedicated planning-DB; DB-wins drift; auto-reopen on staleness; explicit-only deps.
- Semantic (embed) search over planning-cards (rides ticket 14's SurrealDB index when built).

## 7. Open questions
None blocking — the grill settled all forks. Escalation triggers (not decisions): if 10-impl's dependency graph can't reliably key off ticket-cards, escalate to first-class `planning-decision` cards (revisit ticket 08 Q2). Semantic planning-search waits on ticket 14.
