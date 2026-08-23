# spec — hermes-memory dangling-reference integrity sweep (UPSP §4, DO ticket 03)

> **Spec-reality pivot (verified 2026-08-02, per D1 hardening).** The ticket's
> literal mechanism — "parse memory *bodies* for references to other `md_id`s /
> slugs / failure categories" — is a **no-op against real data**: live stores
> (`MEMORY.md`, `failures.md`, fixtures) contain **zero** inter-entry citations.
> Bodies are pure prose; the `→` tokens are code-flow narration, not pointers.
> No reference grammar exists to parse. Implementing the literal ticket would be
> dishonest busywork that never fires.
>
> The genuine "evicted-target rot" the ticket's *Why* describes lives in the
> **structured lineage pointers** (`supersedes` / `supersededBy` / `parentIds`),
> which ARE real, verified, and reachable (see §Mechanism). This spec pivots the
> sweep to that real failure mode. The body-reference parser is **DEFERRED**
> (follow-up) until/unless an explicit reference grammar is introduced.

## Destination

A best-effort, DB-side **integrity sweep** at the markdown→DB session boundary
(`syncMarkdownMemories`, which runs at startup + backend switch): detect memory
entries whose lineage pointers reference a row that no longer exists in the DB
(offloaded / evicted / deleted), and surface them as a **warnings list** (never
a hard failure). Closes the seam where overflow offload deletes a superseded
target but leaves the surviving successor pointing at a now-absent id.

## Mechanism (verified — why the rot is real)

1. `supersedeMemory(priorId, newId)` sets the successor's back-pointers:
   - SQLite `sqlite-memory-repo.ts:918` — `UPDATE memories SET supersedes = ?, parent_ids = ? WHERE id = ?` (sets `new.supersedes = priorId`, `new.parentIds = [priorId]`).
   - Surreal `surreal-memory-repo.ts:981-982` — parity (`supersededBy` on prior; `supersedes`/`parentIds` on new).
2. Overflow offload / eviction deletes the superseded target via `removeByMdId`:
   - SQLite `sqlite-memory-repo.ts:595` — `DELETE FROM memories WHERE id IN (...)`. **No survivor-pointer cleanup.**
   - Driven from `memory-store.ts` `setSupersededContentProvider` offload path (~`:789-825`, `purgeSupersededFromMarkdown` → `offloaded_superseded` md_ids → caller's `removeByMdId` sync).
3. Result: the surviving successor's `supersedes` / `parentIds` now point at an
   **absent** id. The pointer is latent (nothing currently derefs it), but it is
   exactly the "invisible until it bites" rot the ticket names. Surfacing it at
   the session boundary lets a maintainer prune or repair before a future
   lineage-aware feature trips on it.

> Note: a pointer to a **superseded** target (`status === "superseded"`, row still
> present) is **NOT** dangling — that is normal supersession lineage and must NOT
> be flagged (it would be a false-positive flood). Only pointers to **absent**
> rows are dangling. This corrects the ticket's imprecise "target not
> `status=active`" wording.

## Verified code sites (no assumed mappings)

**Lineage fields (the pointers being checked) — `src/store/repository.ts`:**
- `MemoryEntry.supersedes?: number | null` — `repository.ts:26`
- `MemoryEntry.supersededBy?: number | null` — `repository.ts:27`
- `MemoryEntry.parentIds?: number[]` — `repository.ts:28`
- `MemoryEntry.id: number` — `repository.ts:13` (the DB PK every pointer targets)

**Query API (the live-id set) — `src/store/repository.ts`:**
- `getMemories(options?: MemoryListOptions): Promise<MemoryEntry[]>` — `repository.ts:127`.
  `getMemories()` with **no args returns every row** across all targets/projects, each carrying `id`, `status`, `supersedes`, `supersededBy`, `parentIds`. Already used this way at `sync-markdown-memories.ts:89` (`buildExistingIndex`).

**Wire-in seam — `src/handlers/sync-markdown-memories.ts`:**
- `syncMarkdownMemories(...): Promise<BackfillCounters & { projectCount: number }>` — `:317`.
- `BackfillCounters.warnings: string[]` — `:31` (the existing data-side warning channel; rendered in the `/memory-sync-markdown` command output at `:427-433`, capped to first 5).
- Natural insertion: after `backfillFailureState(...)` (`:386`) and the project/in-repo imports, **before `return { ...counters, projectCount }`** (`:402`). The sweep is best-effort, wrapped in try/catch (mirroring the startup sync's own resilience).

**Startup caller (context, not edited) — `src/index.ts`:**
- `:193` — `await perf.timed("startup.syncMarkdownMemories", () => syncMarkdownMemories(...))`; return currently **discarded** (so startup sweep warnings are silent unless later surfaced). Not changed by this ticket — surfacing them to the TUI is a follow-up (the sweep's job is to *populate* `counters.warnings`; the `/memory-sync-markdown` command already renders them).

## Design

- **Pure core** — a new module `src/handlers/integrity-sweep.ts` exports:
  - `DanglingReference` — `{ entryId: number; target: "memory"|"user"|"failure"; field: "supersedes"|"supersededBy"|"parentIds"; missingId: number }`.
  - `findDanglingLineageReferences(entries: MemoryEntry[], freshIds?: ReadonlySet<number>): DanglingReference[]` — pure, no I/O, trivially unit-testable.
  - Logic: build `Set<number>` of present ids; for each entry, for each populated lineage field, any referenced id **not in the set** is a `DanglingReference`. `freshIds` entries are skipped (fresh-successor exclusion — see Freshness).
- **Wire-in** — `sync-markdown-memories.ts`: after imports, `const all = await memoryRepo.getMemories();` then `findDanglingLineageReferences(all)`; push one warning per dangling ref onto `counters.warnings`. Wrapped in try/catch (sweep failure must never break sync). Capped warning push (e.g. first 20) with a `… and N more` summary line, to avoid swamping the warnings array on a grossly-rotted store.

## Freshness — "exclude entries created this round"

The ticket requires fresh-entry exclusion ("fresh-empty is legal"). At the
`syncMarkdownMemories` seam this is **automatically satisfied**: the import path
(`syncMemoryEntriesBatch` / `syncMemoryEntry`) only INSERTs/merges content — it
never sets `supersedes` / `parentIds` (only `supersedeMemory` does, which is not
on the sync path). So freshly-imported entries carry **no** lineage pointers and
cannot be flagged. The pure function still accepts an optional `freshIds`
param for future-proofing (e.g. if later wired into the memory add/replace path
where `supersedeMemory` runs), defaulting empty. **No fresh-tracking plumbing is
added for this ticket** (the `importEntries` inserted-id set is currently
discarded — `sync-markdown-memories.ts:135-140`; threading it out is out of scope).

## Acceptance

1. `findDanglingLineageReferences`: an entry whose `supersedes`/`parentIds` points
   at an id absent from the input list is returned as a `DanglingReference`
   (referencing entry id + target + field + missing id).
2. A pointer to a **present but superseded** (`status==="superseded"`) row is **NOT** flagged (no false positive).
3. `freshIds` entries are skipped (future-proofing) — verified by a unit test that
   injects a fresh successor pointing at an absent prior and asserts it is excluded.
4. Wired into `syncMarkdownMemories`: a rotted store surfaces dangling refs on the
   returned `counters.warnings`; a clean store adds nothing; a thrown sweep is
   swallowed (sync still completes, returns its normal counters).
5. No existing test regresses; `extension-contract` + the test matrix stay green.

## Implementation units (file-scoped, satisfies D2 gate)

| Unit | File | Scope |
|---|---|---|
| Pure core + types | `src/handlers/integrity-sweep.ts` (NEW) | `findDanglingLineageReferences`, `DanglingReference` |
| Wire-in | `src/handlers/sync-markdown-memories.ts` (EDIT, `:386`→`:402` seam) | fetch + sweep + capped warning push, try/catch |
| Tests | `src/handlers/integrity-sweep.test.ts` (NEW) | acceptance 1–3 |
| Wire-in test | `tests/` integration or existing sync test (EDIT) | acceptance 4 (rottable fixture → warning; clean → none; throw → swallowed) |

## Out of scope (explicit follow-ups, not leaks)

- **Body-reference parser** (the literal ticket mechanism) — DEFERRED; no
  reference grammar exists in live data. Reopens if/when bodies start citing
  entries (e.g. a future `[[mdId]]` wiki-link or structured `related:` field).
- **Auto-repair** — sweep *surfaces* only; pruning/rewriting dangling pointers is a human/gated decision (don't silently mutate lineage).
- **TUI surfacing at startup** — `index.ts:193` discards the sync return; piping dangling warnings to `ctx.ui.notify(...,"warning")` is a follow-up.
- **Fresh-id threading from `importEntries`** — currently the inserted-id set is discarded (`sync-markdown-memories.ts:135-140`); not needed at this seam (see Freshness).
- **`getByMdId` lookup helper** — not needed; the sweep is O(n) over a single `getMemories()` fetch (membership via `Set<number>`), matching the `buildExistingIndex` precedent.
