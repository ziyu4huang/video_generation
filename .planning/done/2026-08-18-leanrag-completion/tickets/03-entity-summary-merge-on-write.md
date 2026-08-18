---
status: done
blocking: []
---
# 03 — Entity-summary cache merge-on-write
Spec: Implementation Decisions D6. Anchors: pi-agent-ext-knowledge-card/src/entity-summary.ts:121 (`saveEntitySummaries` — currently writeFileSync wholesale overwrite), :98 (`loadEntitySummaries`), envelope {version:2, entries} at :75-78.
## Work
Inside saveEntitySummaries: load existing entries via loadEntitySummaries, spread-merge `{...existing, ...cache}` before serialize. Keep v2 envelope + content-keyed semantics (distinct entities sharing merged text share an entry — unchanged). Update the PRUNE-ON-REBUILD comment (:82-92) to reflect the now-real consumer path.
## Acceptance
- Round-trip unit test: save A, save B (disjoint keys) in a tmp vault → file contains A∪B.
- Existing zk tests green (`( cd bun-apps/pi-agent-ext-knowledge-card && bun test )`).
- Zero behavior change for in-memory cache semantics.
## Resolution
Landed merge-on-write in `saveEntitySummaries` (load-disk + `{...existing, ...cache}` overlay; PRUNE-ON-REBUILD comment rewritten to note pruning must delete-then-save) with a disjoint-keys round-trip test — package suite green (465 pass, 0 fail).
