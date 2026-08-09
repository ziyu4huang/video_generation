---
type: grilling
status: closed
claimed: pi/memory-session (grilling 09)
blocked by: 08
---
# 09 — .planning DB<->md sync policy

## Question
.planning/ is git-canonical; the DB mirrors it for CRUD/query/dedup/conflict acceleration. Pin the bidirectional sync policy:
1. Write-through (every /wayfind edit updates DB too) vs re-ingest-on-demand vs git-hook-triggered (post-commit/post-merge re-ingest changed .planning files)?
2. Multi-worktree conflict: the SAME ticket edited in two worktrees -> git merge -> how does the KG detect the merge and reconcile the card (both versions / merge-resolution to one card / conflict flag)?
3. Drift resolution: if the md (git) and DB diverge (someone edited md directly bypassing the pipeline), which wins and how is drift detected (content-hash comparison)?
4. Coexistence with the GENERAL sync policy in 05 — is .planning a special case of 05's rule, or a distinct policy?

Blocked by 08. Related: 05 (general sync, open).

## Resolution (2026-08-09, grilled)

`..planning` DB<->md sync policy pinned. `.planning` is git-canonical; the DB (card-store) mirrors it for CRUD/query/dedup/conflict acceleration. Three forks resolved:

- **Sync trigger (Q1):** On-demand refresh + background backfill. The card-store refreshes lazily when a query/CRUD hits stale data (content-hash check), plus a background backfill sweeps changed `.planning` files. No git hooks — robust across worktrees and agent edits; matches ticket 04's lazy + background-backfill house style. (Rejected: write-through — couples write paths, misses external md edits; git-hook-triggered — unreliable across worktrees/agents.)
- **Multi-worktree merge (Q2):** Git resolves the md (git is canonical); re-ingest detects the content-hash change and re-mirrors the merged card; if the merge left conflict markers in the md, flag that effort for human review. (Rejected: keep-both-versions — leaves the store inconsistent with git; explicit-conflict-gate — blocks the common case.)
- **Drift policy (Q3):** `.planning` is a Tier-1 instance of ticket 05's 3-tier drift — md (git) wins; drift detected via content-hash; re-ingest on drift. No special-casing; reuses the general policy. (Rejected: distinct custom policy — duplicates the model.)

**Build track:** defines the sync layer the 09-impl build ticket will construct on top of the ticket-08 card model. Combined with 08 (hermes owns store; planning-cards namespaced) and 05 (3-tier drift), the `.planning` mirror is a Tier-1, content-hash-staleness, lazy+backfill card-store tenant.
