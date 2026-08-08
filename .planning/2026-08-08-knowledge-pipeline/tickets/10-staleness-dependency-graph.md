---
type: grilling
claimed:
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
