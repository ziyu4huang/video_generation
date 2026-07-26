---
type: grilling
blocked by: []
status: open
---

# 01 — saveIndex persist-after-incremental-refresh policy

## Question

After #841 / #850, writes (`appendUnderHeading`, `obsidian_create`,
`obsidian_append`, `updateFrontmatter`) reindex **incrementally** via
`reindexFile`, and external edits reconcile via `refreshIndex`. But `saveIndex`
(persist the index to the on-disk `.cache`) only fires on a **cold `getIndex`
build** — neither `refreshIndex` nor `reindexFile` persists. So the on-disk cache
lags the in-memory index across a session; the next cold start re-scans.

The KNOWN-ISSUES note calls this a **perf gap, never correctness**
(`loadCachedIndex` mtime-validates per note on load, so a stale cache is
self-healing).

**Decision: fix / mitigate / accept-as-wontfix?**

- If **fix**: spec the persist hook — where (end of `refreshIndex`?
  `reindexFile`?), throttling (avoid a disk write per write), and a coherence
  test (persisted cache survives a simulated restart and reflects an incremental
  edit). One PR.
- If **accept**: one-line rationale for KNOWN-ISSUES → Accepted.

## Read first (to inform the decision)

- `src/lib/index.ts`: `saveIndex`, `refreshIndex`, `reindexFile`, `getIndex`
  (the cold-build persist site), `loadCachedIndex` (mtime validation).
- `scripts/bench-index-persistence.mjs` — is there a measured cost baseline?
