# spec — hermes-memory `pin` field (UPSP §4.11, DO ticket 02)

## Destination

A `pin: true` frontmatter field marking a memory entry as **never eligible for overflow-driven eviction / consolidation / offload** — "always remember this." The user/agent can lock an entry so it survives any char-overflow purge.

## The field

- **Frontmatter (YAML):** `pin: true` (boolean; absent / false / invalid → unpinned). Target-agnostic (applies to `memory` / `user` / `failure`). Sits after `severity` in field order: `id → created → last → state → severity → pin → provenance → sources → memworth`.
- **Coerce:** new `normalizePin(v): boolean` (beside `normalizeFailureState`).
- **DB mirror:** `pin INTEGER NOT NULL DEFAULT 0` (SQLite) + Surreal parity.

## Verified code sites (no assumed mappings)

**Frontmatter — `src/store/memory-format.ts`:**
- parse output type `ParsedMarkdownMemoryEntry` (L179, alongside `state`/`severity`) → add `pin?: boolean`.
- frontmatter parse branch (~L374+) → read `pin`.
- `serializeFrontmatter` input type (L330-331) + logic (L343, alongside `severity`) → emit `pin: true` when set.
- new `normalizePin` helper (beside `normalizeFailureState`, L53).

**SQLite — `src/store/sqlite/`:**
- `schema.ts` `memories` table (~L91, after `severity`) → `pin INTEGER NOT NULL DEFAULT 0`.
- `sqlite-backend.ts`: INSERT column list (L517) + bound value; SELECT row→entry map (L564); migration ALTERs (L715-731) → `ALTER TABLE memories ADD COLUMN pin INTEGER NOT NULL DEFAULT 0` (idempotent guard).

**Surreal — `src/store/surreal/surreal-backend.ts`:**
- parity: add `pin` to the memory model + upsert/select queries.
- `repository-contract.test.ts` → add `pin` to the SQLite↔Surreal equivalence assertions.

**Eviction skip — `src/store/memory-store.ts`:**
- the overflow offload / consolidation **victim selection** (`offloaded_superseded` path ~L701-865 + the consolidation victim picker) → exclude `pin === true` entries from eviction candidates. A pinned entry survives overflow even if superseded (pin protects *deletion*; supersession still flips `status` for search, but the `.md` row is not purged).

## Acceptance

1. `pin: true` round-trips through frontmatter parse → serialize (and absent → not emitted).
2. A pinned entry **survives** an overflow consolidation / offload that evicts non-pinned peers (new test — the ticket-02 core assertion).
3. DB mirrors `pin`; `repository-contract` equivalence holds for `pin`; migration is idempotent (existing DBs → `pin = 0`).
4. No existing test regresses.

## Out of scope (explicit follow-ups, not leaks)

- A tool surface to set `pin` (memory tool `add`/`replace` accepting `pin`) — MVP is frontmatter-editable; tool wiring is a follow-up ticket.
- Heat/decay interaction — pin protects *deletion*, not *decay*; decay arrives with the DEFER metabolism (UPSP #1b).
- Auto-suggesting pin — always explicit (user/agent sets it).
