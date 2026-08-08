type: grilling
blocked by: 01

## Question

Two transition decisions once the card-agnostic store (01) is defined:

- **Memory-card migration**: do existing hermes section-md memory-cards get migrated into the card-agnostic store now (typed kind: memory), or do they COEXIST (memory stays on the old path, knowledge on the new) during this effort? Trade-off: migration = one store sooner but risk to the working memory system; coexist = safe, two paths until a later migration. (Bulk MEMORY.md to knowledge-card rewrite is explicitly out of scope; this is only about the store, not the content shape.)
- **DB<->md bidirectional sync conflicts**: md is canonical (decided). Define what happens on drift — e.g. a card edited in md after its DB mirror, or a DB-only field with no md representation. Re-gen-from-md? Last-write-wins with a warning? Conflict-surfacing merge-plan (zk/merge-plan.ts exists)? Pin the resolution policy, especially for knowledge-cards whose graph edges may live DB-side.

Blocked by 01 (the card-agnostic schema determines both the migration target and the sync field set). Grilling, one fork at a time.
