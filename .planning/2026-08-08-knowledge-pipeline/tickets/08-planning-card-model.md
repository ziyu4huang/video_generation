---
type: grilling
claimed:
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
