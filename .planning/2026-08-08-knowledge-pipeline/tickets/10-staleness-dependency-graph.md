---
type: grilling
status: closed
claimed: pi/memory-session (grilling 10)
blocked by: 08
---
# 10 — Staleness via source-dependency graph

## Question
Grilling (2026-08-08) chose source-dependency graph: closed decisions declare dependencies; the system re-validates a decision when one of its deps changes (git diff / content-hash / mtime). Pin the design:
1. Dependency TYPES: effort<->effort (Supersedes / Absorbed-by / Covered-by / Shares-decision-with), ticket->ticket (blocked-by, superseded), decision->source-file (cited code/path), decision->effort. Which are auto-inferred from existing wayfinder cross-link conventions vs explicitly declared?
2. How does a closed decision DECLARE its deps — a front-matter field (e.g. depends_on: [paths]) vs auto-inferred from paths cited in the Resolution body?
3. Re-validation trigger: on git diff touching a dep (event-driven) vs on-access check vs periodic sweep? What computes "changed" (content-hash of the dep since last validation)?
4. Surfacing: how is a stale decision presented (flag on the card, query stale:, block graduation of the effort?) and who acts on it (agent re-grills / auto-reopen ticket)?

Blocked by 08. Related: 03 (two-layer graph — staleness edges may live there; plus absorbed hermes-surrealdb-graph-search prior art).

## Resolution (2026-08-09, grilled)

Source-dependency staleness design pinned. Closed decisions declare dependencies; the system re-validates a decision when a dep changes. Three forks resolved (keys off ticket-cards — no first-class decision entities, per ticket 08):

- **Dependency model (Q1):** v1 auto-infers two edge kinds: ticket→ticket `blocked-by` (from frontmatter) and decision→source-file (paths cited in the Resolution body). Plus an optional explicit `depends_on: [paths]` frontmatter field for manual additions/overrides. Effort-level relations (Supersedes/Absorbed-by/Covered-by/Shares-decision-with) are DEFERRED. Works off ticket-cards (consistent with ticket 08's inline-decisions model). (Rejected: explicit-only — relies on declaring every edge; full-auto-infer — high false-positive risk.)
- **Re-validation trigger (Q2):** On-access content-hash check — when a decision/card is queried or an effort's graduation is evaluated, compare each dep's current content-hash to its last-validated hash; a background sweep flags stale ones. Same shape as ticket 09's on-demand model. (Rejected: event-driven git-diff — unreliable across worktrees/agents; periodic-only — no on-access correctness.)
- **Surfacing & action (Q3):** A `stale:` flag on the card + a `stale:` query; block an effort's graduation while it has stale decisions; the agent re-grills to resolve (re-open ticket, re-validate, update resolution). Human/agent gates the re-grill. (Rejected: auto-reopen — removes the gate; advisory-only — staleness silently ignored.)

**Build track:** Phase 2 now fully scoped — 08 (card model) → 09 (sync) → 10 (staleness). Implementation = build tickets for the planning-card serializer + card-store tenant (08-impl), the on-demand+backfill sync layer (09-impl), and the dependency-graph + staleness check (10-impl), all riding the hermes spine + consolidated SurrealDB from prior decisions.

**SHIPPED — 10-impl via #1242 (squash `1fcb4504`).** The staleness dependency-graph implementation landed; Phase-2 (08/09/10) is now fully shipped.
