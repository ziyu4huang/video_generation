---
type: grilling
status: closed
claimed: pi/memory-session (grilling 08)
blocked by: 06
---
# 08 — Planning-card model (wayfind self-application)

## Question
The pipeline self-applies to wayfinder's own .planning/<effort>. Grilling (2026-08-08) chose per-ticket granularity: each tickets/NN.md = one card (kind=planning-ticket); map.md = an index card.

Pin the planning-card contract + CRUD surface:
1. Card schema for kind=planning-ticket: content = ticket body; frontmatter = ticket front-matter (type/claimed/blocked by) + status (open/closed) + resolution-gist. How is map.md represented (index card linking its tickets)? How are closed-ticket Resolutions + Decisions-so-far lines made queryable (separate decision-cards, or fields on the ticket-card)?
2. CRUD surface wayfinder gains: create/update/close ticket -> card upsert; query ("tickets about X across all efforts"); near-duplicate ticket detection; conflict = contradictory resolutions across efforts — what is the detection signal (e.g. two closed tickets with overlapping scope + divergent decisions)?
3. Does wayfind CONSUME hermes's store as a client (loose: wayfind calls hermes CRUD/query) or does hermes directly own .planning/ (tight)? (User said "leverage hermes approach" -> lean loose.)
4. Namespace: planning-cards in the SAME SurrealDB/SQLite as knowledge-cards (separate table/graph-namespace) or a dedicated planning-DB?

Blocked by 06. Related: 01 (Card model, closed).

## Resolution (2026-08-09, grilled)

Planning-card model pinned for wayfinder's self-application of the pipeline to `.planning/<effort>`. Four forks resolved:

- **Ownership/integration (Q1):** Hermes owns ingest + store; wayfinder is the client. `walkAndIngest` ingests `.planning/`, the card-store mirrors it, and a planning-card serializer plugs into hermes (consistent with ticket 06 hermes-as-spine + ticket 01 pluggable serializer). Wayfinder stays the semantic owner of the planning domain and consumes the store for CRUD/query/dedup. (Rejected: wayfind-owns-own-store — duplicates the spine; hermes-owns-semantics — wayfind loses domain ownership.)
- **Card schema (Q2):** `map.md` → an effort index card (`kind=planning-effort`); each ticket → a `planning-ticket` card — body in `content`, `type/claimed/blocked-by/status/resolution-gist` in `frontmatter`, full `## Resolution` carried in `content`. Decisions are queryable via search over ticket + effort cards (sufficient for the Phase-1 list/search and for conflict flags). First-class `planning-decision` cards are DEFERRED — escalate only if ticket 10's staleness dependency graph can't key off ticket-cards.
- **Storage namespace (Q3):** Planning-cards live in the SAME SurrealDB/SQLite as knowledge-cards, in a separate table/graph-namespace (kind-prefix/namespace field). Single store, consistent with ticket 04's consolidation. (Rejected: dedicated planning-DB — duplicates infra, blocks cross-domain query.)
- **Conflict detection (Q4):** Heuristic — flag pairs of CLOSED planning-ticket cards that share scope (tag/effort/topic overlap, or a cited source path) but have DIVERGENT `resolution-gist`. Surfaced as a `conflict:` query/flag. Reuses the graph (tickets 03/10); no first-class decision entities required. (Rejected: explicit declared links — too manual; none-in-v1 — defers a core self-application value.)

**Build track:** unblocks ticket 09 (sync policy — needs the card fields to compare) and ticket 10 (staleness — keys off ticket-cards' cited paths + resolution-gist). Phase-2 implementation = build tickets 09/10 on this model.
