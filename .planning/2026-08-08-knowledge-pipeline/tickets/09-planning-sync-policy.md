---
type: grilling
claimed:
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
