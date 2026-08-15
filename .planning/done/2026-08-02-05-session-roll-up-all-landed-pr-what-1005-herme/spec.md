# spec — hermes-memory per-session assembly log (prompt-provenance) — UPSP §5, DO ticket 05

> **Origin:** UPSP study effort `2026-08-02-try-to-checkout-code-use-gh-and-learning-from-ht`,
> ticket `tickets/05-do-session-assembly-log.md` + `findings.md` §5. This spec formalizes the
> five design decisions settled in the chart-the-map grill (2026-08-02); see `map.md`.

## Destination

At `session_start`, capture **once per session** the prompt-provenance of the memory block
hermes-memory injects: the **set of `md_id`s assembled across all injected blocks** (global
memory + global user + post-filter active-failures + project memory) plus a **SHA-256 of the
rendered block** (the `request_body_sha256` analogue). Persist to a new normalized
`session_assembly(session_id, md_id)` table + a separate FK-free `session_assembly_meta(session_id, hash)` table, on
**both** SQLite and Surreal backends. This is the **cheap tier only** — no query tool, no
replay harness, no #06 used-signal, no supersede-audit fix (all Out of scope).

It closes the gap UPSP §5 names: we have *entry* provenance (where an entry came from) but
not *prompt* provenance (what went into a given session's prompt). With it we can answer
"which sessions saw the stale version of memory M before it was superseded?" and detect
drift, and it is the prerequisite base for the deferred #06 used-signal.

## Mechanism (verified — why the seams are real)

1. **The block is assembled in `buildPromptContext`** — `src/prompt-context.ts:31`
   (`buildPromptContext(config, store, projectStore, projectName)`). It calls
   `store.formatForSystemPrompt()` (memory+user+failures) and `projectStore.formatProjectBlock(projectName)`,
   joins the non-empty parts with `"\n\n"`. Returns `""` in `policy-only` mode.
2. **`formatForSystemPrompt()`** — `src/store/memory-store.ts:1260`. Renders from
   `this.snapshot.memory` + `this.snapshot.user` + `this.getActiveFailureEntries(maxAgeDays).slice(0, maxFailures)`.
3. **`formatProjectBlock(projectName)`** — `src/store/memory-store.ts:1290`. Renders from
   `this.memoryEntries` (project store instance — project memory target only).
4. **`loadFromDisk()`** — `src/store/memory-store.ts:431`. Populates the raw
   `memoryEntries`/`userEntries`/`failureEntries` (which **retain frontmatter ids**) and the
   frozen `snapshot` (built from *stripped* entries — ids lost). Called at `session_start`
   (`src/index.ts:311`-area) **before** the capture point, so ids are available there.
5. **`md_id` extraction** — `parseMetadataFrontmatter(raw)` → `fm.id` (surfaced as `mdId`),
   `src/store/memory-format.ts:374`/`:248-252`. `MemoryStore.decodeEntry(raw)` returns
   `{ id, ... }`; already used to harvest ids at `memory-store.ts:972`/`:1034`
   (`evictedDecoded.map((e) => e.id).filter(Boolean)`).
6. **`getActiveFailureEntries(maxAgeDays = 7): string[]`** — `src/store/memory-store.ts:663`.
   Returns the raw active-failure entries (the post-filter injected set). Config bounds:
   `failureInjectionMaxAgeDays` / `failureInjectionMaxEntries` (`formatForSystemPrompt` reads
   them at `:1271-1272`).
7. **Session id at the hook** — `ctx.sessionManager.getSessionId()` (pi `extensions.md:669`),
   available in every handler. `sessionRepo` is already in scope at the `session_start`
   handler: `src/index.ts:170` (`const sessionRepo = asSwappable<SessionRepository>(...)`),
   used there at `:312`.

> **Why `session_start`, not `before_agent_start`.** `before_agent_start` (`src/index.ts:331`)
> fires **per agent-run** (per submitted prompt — pi `extensions.md:521` "Fired after user
> submits prompt"), and the in-memory store can mutate mid-session via the memory tool. Per-
> session capture at `session_start` (once) is the settled granularity (see §Design D3).
> Mid-session writes are already audited by the memory tool's `added_md_id`/supersession
> lineage, so "did session S see M?" = loaded-at-start ∪ written-during-S — both covered.

## Verified code sites (no assumed mappings)

**Schema — SQLite, `src/store/sqlite/schema.ts`** (`SCHEMA_SQL`): append two FK-free tables
(no `sessions` column change, no `ensureSessionsColumns` edit):
- `session_assembly (session_id TEXT NOT NULL, md_id TEXT NOT NULL, PRIMARY KEY(session_id, md_id))` + `CREATE INDEX IF NOT EXISTS idx_session_assembly_md_id ON session_assembly(md_id);`
- `session_assembly_meta (session_id TEXT NOT NULL PRIMARY KEY, hash TEXT NOT NULL, captured_at TEXT NOT NULL)`.
Both are `CREATE TABLE IF NOT EXISTS` (idempotent); no FK, so no migration of existing rows.

**Schema — Surreal, `src/store/surreal/schema.ts`** (schemaless `DEFINE TABLE ... SCHEMALESS`,
`:15-21`): append
- `DEFINE TABLE IF NOT EXISTS session_assembly SCHEMALESS;` + `DEFINE INDEX IF NOT EXISTS session_assembly_md_id ON TABLE session_assembly FIELDS mdId;` + `DEFINE INDEX IF NOT EXISTS session_assembly_session ON TABLE session_assembly FIELDS sessionId;`
- `DEFINE TABLE IF NOT EXISTS session_assembly_meta SCHEMALESS;` + `DEFINE INDEX IF NOT EXISTS session_assembly_meta_sid ON TABLE session_assembly_meta FIELDS sessionId UNIQUE;`
(The session UPSERT at `surreal-session-repo.ts:83` is NOT changed — assemblyHash is not stored on the session doc.)

**Repo interface — `src/store/repository.ts`:**
- `SessionRepository` — `:174`. Add `recordAssembly(sessionId: string, mdIds: readonly string[], hash: string): Promise<void>;`.
- `SessionRecord` — `:184`.

**Repo impls** (neither touches the `sessions` table — see §Timing):
- SQLite — `src/store/sqlite/sqlite-session-repo.ts`. `recordAssembly` (mirrors the `writeXToDb` core + wrapper idiom): upsert a `session_assembly_meta` row (hash) + `DELETE` then batch-`INSERT OR IGNORE` `session_assembly` rows, in one transaction.
- Surreal — `src/store/surreal/surreal-session-repo.ts`. `recordAssembly`: `UPSERT type::record("session_assembly_meta", $sid) SET hash=...` + `DELETE FROM session_assembly WHERE sessionId=$sid` + batch `CREATE session_assembly`.

**Capture wire-in — `src/index.ts`** `session_start` handler (`:261`), after
`store.loadFromDisk()`/`projectStore.loadFromDisk()` and the stable-id backfill (`:311-322`),
alongside the existing `scheduleSessionBackfill(sessionRepo, ...)` call (`:312`).

## Design

**D1 — Scope:** cheap-tier capture only (no query tool / replay / #06 / supersede-audit).

**D2 — What's captured:** the `md_id` set across **all injected blocks** — global memory +
global user + **post-filter** active-failures (`getActiveFailureEntries(maxAge).slice(0,max)`,
mirroring `formatForSystemPrompt` exactly) + project memory. One set per session.

**D3 — Capture when:** **once per session at `session_start`** (after `loadFromDisk`).
Rejected per-run capture (`before_agent_start`) — mid-session mutations are separately audited.

**D4 — Storage:** normalized **`session_assembly(session_id, md_id)`** (one row per assembled
id; composite PK dedupes) **FK-free** — `session_id` is a plain join key, NOT an enforced FK,
because the `sessions` row is created *later* by deferred backfill (`setTimeout(0)`, see §Timing)
so an FK would violate at capture time. The hash lives in a separate FK-free
**`session_assembly_meta(session_id PK, hash, captured_at)`** table — it cannot reliably sit on
`sessions` (NOT NULL project/cwd; row created post-capture). Headline query is a LEFT JOIN:
`SELECT sa.session_id, s.project FROM session_assembly sa LEFT JOIN sessions s ON s.id = sa.session_id WHERE sa.md_id = ?`
(project/cwd null until the session is indexed; session_id always present). Friendliest base for
deferred #06. Both backends.

**Timing (why FK-free):** the `sessions` row is written only by `scheduleSessionBackfill`
(`session-backfill.ts:48`/`:73`, deferred `setTimeout(0)` "so session_start can [return]") and
`scheduleLiveSessionIndex` on `message_end` (`index.ts:472`). Neither is synchronous in
`session_start`, so at the capture point the `sessions` row does not exist — hence no FK, and
the hash goes in its own table.

**D5 — Hash scope:** SHA-256 of the **full rendered memory block** — the exact string
`buildPromptContext` returns (`memoryBlock "\n\n" projectBlock`, the fenced/header'd text
literally injected), **excluding** the constant policy text. Detects set-membership *and*
per-entry text drift. (Empty block → no record written; `policy-only` mode → skip.)

**Set↔hash consistency (DRY):** to guarantee the logged id set and the hashed block come from
the *same* entry selection, refactor the assembly so a shared core returns both:
- `MemoryStore.getAssemblyManifest(): { block: string; mdIds: string[] }` — mirrors
  `formatForSystemPrompt()` rendering but harvests ids (`decodeEntry`) from the *same*
  `memoryEntries` + `userEntries` + `getActiveFailureEntries(max).slice(0,max)` it renders.
- `MemoryStore.getProjectAssemblyManifest(projectName): { block: string; mdIds: string[] }`
  — mirrors `formatProjectBlock(projectName)`, harvesting ids from the same `memoryEntries`.
- `buildPromptAssembly(config, store, projectStore, projectName): { mdIds: string[]; hash: string } | null`
  in `prompt-context.ts` — joins the two manifests exactly as `buildPromptContext` joins
  blocks, unions the ids, SHA-256s the joined block. Returns `null` for `policy-only` or an
  empty block. `buildPromptContext`'s signature is **unchanged** (no ripple to `index.ts:331`
  or `handlers/preview-context.ts`).

**Best-effort:** capture is wrapped in try/catch at the wire-in (mirrors the startup sync's
own resilience, e.g. `backfillStableIds` guard at `index.ts:314`); a capture failure NEVER
aborts agent startup. The per-session record is upserted (idempotent on resume: delete-then-insert).

## Acceptance

1. `getAssemblyManifest()` returns the **same rendered block** as `formatForSystemPrompt()`
   AND the `md_id` set of exactly the entries that block was built from (memory + user +
   post-filter active-failures). Verified by a unit test asserting block equality + id set.
2. `getProjectAssemblyManifest(name)` likewise mirrors `formatProjectBlock(name)` + project
   memory ids.
3. `buildPromptAssembly` returns `null` for `policy-only` mode and for an empty store; for a
   populated store returns `{ mdIds: [...unique], hash: sha256(memoryBlock+"\n\n"+projectBlock) }`.
4. `recordAssembly(sid, mdIds, hash)` on **both** backends: writes one `session_assembly` row
   per id + a `session_assembly_meta(session_id, hash)` row; idempotent (re-call replaces, no
   duplicate rows); the headline query `SELECT DISTINCT session_id FROM session_assembly WHERE md_id = ?` returns
   the session. Neither backend touches the `sessions` table.
5. Wired into `session_start`: a fresh session with loaded memory produces a `session_assembly`
   row per injected id + the hash in `session_assembly_meta`; a thrown capture is swallowed (startup
   completes); `policy-only` writes nothing.
6. No existing test regresses; `bun test` (hermes-memory) + `extension-contract` stay green;
   both SQLite and Surreal code paths compile.

## Implementation units (file-scoped, satisfies D2 gate)

| Unit | File | Scope |
|---|---|---|
| Store manifest (pure) | `src/store/memory-store.ts` (EDIT) | `getAssemblyManifest()`, `getProjectAssemblyManifest(name)` — id harvest via `decodeEntry`, mirroring the two renderers |
| Assembly builder (pure) | `src/prompt-context.ts` (EDIT) | `buildPromptAssembly(...)` — union + SHA-256; `buildPromptContext` signature unchanged |
| Repo interface | `src/store/repository.ts` (EDIT, `:174`) | `recordAssembly(sessionId, mdIds, hash)` |
| SQLite schema | `src/store/sqlite/schema.ts` (EDIT) | FK-free `session_assembly` table + idx + `session_assembly_meta` table (no `sessions` change, no migration) |
| SQLite repo | `src/store/sqlite/sqlite-session-repo.ts` (EDIT) | `recordAssembly` (upsert meta + delete-then-batch-insert assembly; no `sessions` touch) |
| Surreal schema | `src/store/surreal/schema.ts` (EDIT) | `DEFINE TABLE session_assembly`/`session_assembly_meta` SCHEMALESS + indexes |
| Surreal repo | `src/store/surreal/surreal-session-repo.ts` (EDIT) | `recordAssembly` (upsert meta record + delete-then-batch-create assembly) |
| Wire-in | `src/index.ts` `session_start` (EDIT, `:312`-area) | `buildPromptAssembly` → `sessionRepo.recordAssembly(getSessionId(), …)`, try/catch |
| Tests | `tests/store/memory-store.test.ts` (EDIT), `tests/prompt-context.test.ts` (NEW), `tests/store/sqlite-session-repo.test.ts` (EDIT), `tests/store/surreal/surreal-session-repo-contract.test.ts` (EDIT) | acceptance 1–6 |

## Out of scope (explicit follow-ups, not leaks)

- **Query surface / TUI command** — DB-level join only; no `/memory-sessions-that-saw` tool.
- **Replay / drift-detection harness** — UPSP stronger tier (`replay_material_retention`
  analogue). DEFERRED until decaying/consolidating memory can drift.
- **#06 used-signal (UPSP §9)** — its own effort; builds on this log's joins.
- **Destructive-supersede audit-row smell** — §5 "receipt" gap on `offloaded_superseded`;
  separate supersession-provenance effort.
- **Per-run / per-mutation capture** — rejected (see D3); mid-session writes already audited.
- **Surfacing assembly warnings to the TUI** — capture is silent by design (best-effort).
