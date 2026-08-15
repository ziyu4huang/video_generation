---
type: grilling
blocked by: [00-md-identity-model]
claimed: pi (wayfinder, 2026-08-01)
status: closed
resolved: 2026-08-01
---

## Question

How does the stable id interact with the **5b capacity loop** and **5c supersession**? Specifically: (a) **consolidation** (5b, destructive) — does the merged entry get a *fresh* id (consistent with D0 "no inherited lineage") and are the consumed entries' ids deleted? (b) **trim / vault-offload** — do vaulted (archived) entries keep their id so the archive stays joinable to the DB? (c) **supersession** (5c) — when an entry is superseded, does its `.md` id persist unchanged (so the DB lineage row stays linked)?

## Why

5d cannot break the capacity loop 5b just stabilized. The id's lifecycle across consolidation (create/delete), offload (move), and supersession (status flip) must be defined or 5b's offload-superseded-first + destructive-consolidation invariants stop holding. This is where "id-only" meets "lineage stays in DB": the id is the *handle* the DB lineage hangs off, so its stability rules ARE the lineage-stability rules.

## First takeable step

After 00 resolves, grill each sub-question against the 5b plan's D0–D4:

1. **Consolidation** — fresh-id-for-merged + delete-consumed-ids is the D0-consistent answer (destructive compaction, traceless). Confirm, and confirm the DB rows for consumed ids are deleted in the same transaction (5b's `offloaded_superseded`/`syncEvictions` path).
2. **Offload** — id travels to the vault archive entry (so `vault ↔ DB` stays joinable). Confirm the archive format carries the id.
3. **Supersession** — id is immutable across the active→superseded status flip (the whole point: a stable handle). Confirm 5c's supersede flow never rewrites the `.md` id.

No new code here — this ticket produces the **id-lifecycle contract** that the eventual implementation plan encodes. May graduate a "contract test" task once closed.

## Resolution (2026-08-01)

**Id-lifecycle contract** — verified against the 5b plan (D0–D4) + code (`memory-store.ts` `vaultOffloadAndAdd`, `memory-tool.ts` caller), and determined by ticket 00 (uuid immutability) + ticket 02 (lineage is DB-only; `md_id` is the join key):

- **Birth** — uuid assigned at entry creation; existing entries backfilled per ticket 01.
- **Life (incl. supersession, 5c)** — **immutable**. The active→superseded transition is a DB *status* flip; the `.md` id and the DB `md_id` are unchanged, so the lineage row stays linked via `md_id`. 5c's supersede flow never rewrites the id.
- **Death — consolidation (D0/D4)** — the LLM-merged entry is fresh-active with no inherited lineage → it gets a **fresh uuid**. Consumed entries' `.md` lines + DB rows + `md_id` are **hard-deleted** (no audit/tombstone). Id-based once ticket 04 retires content-key.
- **Death — offload — uniform & traceless on both paths:** D2 offload-superseded (`offloaded_superseded`) and the vault-offload floor (`evicted_entries`) both flow through `syncEvictionsFromSqlite` → DB row + `md_id` deleted together.

**Correction to this ticket's (b) premise:** "vaulted entries stay joinable to the DB" is wrong — verified that vault-offload **deletes the DB row** (eviction, not archival-in-place). The `.knowledge.jsonl` archive is a preservation/audit artifact, not a live join target.

**Open thread (this grilling) — IN SCOPE:** the vault-offload `.knowledge.jsonl` archive **carries the retired `md_id` as a provenance field** (cheap traceability: an Obsidian vault note post-zk_ingest can cite its hermes-memory origin). It is **not** a join key (the DB row is already deleted).

**Graduation:** none as a wayfinder ticket. The contract is to be **encoded as contract tests** in the eventual 5d implementation plan (writing-plans): assert fresh-uuid-on-consolidation + consumed-id-deleted; offload deletes `md_id`; supersession preserves `md_id`.
