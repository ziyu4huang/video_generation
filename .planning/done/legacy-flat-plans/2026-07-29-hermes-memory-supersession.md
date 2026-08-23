# Hermes Memory Supersession — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add versioned append-only supersession: each memory entry gains `status` (active|superseded), `supersedes`, `supersededBy`, `parentIds[]`; `memory_search` defaults to `status='active'` (superseded entries stop surfacing); a new `memory_supersede` tool lets the agent retire a stale entry by creating a linked replacement + flipping the prior to `superseded` + a verification probe. This is the **mechanism** (agent-driven); the auto-trigger + consolidation-coupling are Plan 5.

**Architecture:** **DB-only lineage** (resolves spec §8's `.md`-has-no-id problem, consistent with worth/`last_referenced`). The four fields are DB columns by DB-id; `.md` doesn't express them. The sync-merge UPDATE has a fixed SET list → doesn't touch status/lineage → **lineage persists across same-DB re-sync** (id stable); lost on fresh clone (re-establishable). No `.md` rewrite. The `memory_supersede` tool is **standalone** (`registerMemorySupersedeTool`, new file — type-safe, no `@ts-nocheck`): it creates the replacement via `store.add` (`.md`) + captures `memoryRepo.syncMemoryEntry(...)` to get the new id (the existing `syncAddToSqlite` helper DISCARDS the id, so it can't be reused), then calls `supersedeMemory(priorId, newId)` (DB lineage flip) + runs a verification probe (`searchMemories` naturally hides the prior via the new status filter). `parentIds` is a JSON-string column in SQLite, a native array in Surreal (SCHEMALESS).

**Tech Stack:** TypeScript, `bun test` (`node:test`/`assert` for store tests; `bun:test` `expect/it` for repo/tool/contract tests — match each file), on-disk tmpdir fixtures.

**Spec reconciliation / design decisions:**
- **DB-only lineage** — `.md` has no id; DB ids aren't stable across clone. Status/lineage are DB-authoritative (like worth/`last_referenced`); persist across same-DB re-sync (merge preserves), lost on fresh clone. No stable-id infra in v1. *(Clone-durable lineage via stable ids is a future plan.)*
- **Mechanism only (agent-driven tool)** — the auto-trigger (correction→supersede) is **deferred to Plan 5** because correction-detector *doesn't know which prior a correction supersedes* (attribution problem — Plan 1 research). The tool sidesteps it: the agent passes `priorId`.
- **Consolidation-coupling deferred to Plan 5** — the consolidator is LLM-prompt-driven + sees stripped `.md` (can't see DB status); full protection needs the prompt edit + more. v1 risk: consolidation *could* merge a superseded entry (rare, char-limit-driven) — documented.
- **`reason` is a tool-layer detail** (not a DB column); `evidence[]` attaches via Plan 1's `sources[]` on the replacement entry.
- **No ranking behavior change** — the status filter hides superseded rows (they don't enter the candidate pool); all-active rows rank exactly as before.

## Global Constraints

- **Dual-backend symmetry** — every column/mapRow/INSERT/filter/supersedeMemory change in BOTH `sqlite-memory-repo.ts` and `surreal-memory-repo.ts`, passing the shared contract.
- **Status filter defaults to hiding superseded** (`includeSuperseded` defaults `false` in `MemorySearchOptions`); applies in `searchMemories` AND `fetchGraphNeighbors` (both backends) — else superseded neighbors leak via graph expansion. **Mutation paths (sync/replace/remove) must NOT get the filter** (they operate on all rows).
- **`getMemories` stays unfiltered** (enumerate-all semantics; tests rely on it) — do not add the status filter there.
- **Use UPDATE, never DELETE+INSERT, for the status/lineage flip** — the DB id MUST stay stable (lineage references it; FTS triggers fire but are harmless since content is unchanged).
- **`memory_supersede` tool captures `syncMemoryEntry`'s result** (do NOT reuse `syncAddToSqlite` — it discards the new id).
- Two-step non-atomic (store.add → sync → supersedeMemory) — document the partial-failure mode (if supersedeMemory fails after the replacement synced, you get a new active entry with no flip; recoverable by retry). Best-effort, like FIFO-evict sync.
- Run tests via `( cd bun-apps/pi-agent-ext-hermes-memory && bun test … )` — never top-level `cd`.

## File Structure

- **Create:** `src/tools/memory-supersede-tool.ts` (`registerMemorySupersedeTool`), `tests/tools/memory-supersede-tool.test.ts`
- **Modify:** `src/store/repository.ts` (`MemoryEntry` +4 fields, `MemorySearchOptions` +`includeSuperseded`, `MemoryRepository` +`supersedeMemory`)
- **Modify:** `src/store/sqlite/schema.ts` (DDL), `src/store/sqlite/sqlite-backend.ts` (`ensureMemoriesColumns` + `copyMemories` + both `migrateLegacyMemoriesTargetConstraint` branches)
- **Modify:** `src/store/sqlite/sqlite-memory-repo.ts` (`MEMORY_SELECT_COLUMNS`/`MemoryRow`/`mapRow`/INSERTs + status filter in `searchMemories`+`fetchGraphNeighbors` + `supersedeMemory`)
- **Modify:** `src/store/surreal/surreal-memory-repo.ts` (`FIELDS`/`Row`/`mapRow`/CREATE SET + status filter in `buildScope` read paths + `supersedeMemory`)
- **Modify:** `src/index.ts` (mount `registerMemorySupersedeTool`)
- **Modify:** `tests/store/db.test.ts` (migration), `tests/store/repository-contract.test.ts` (status filter + supersedeMemory round-trip + re-sync stability)

---

## Task 1: Types — MemoryEntry lineage fields + MemorySearchOptions + supersedeMemory interface

**Files:**
- Modify: `src/store/repository.ts` (`MemoryEntry`, `MemorySearchOptions`, `MemoryRepository`)

**Interfaces:**
- Produces: `MemoryEntry.status?: "active" | "superseded"`, `.supersedes?: number | null`, `.supersededBy?: number | null`, `.parentIds?: number[]`; `MemorySearchOptions.includeSuperseded?: boolean`; `MemoryRepository.supersedeMemory(priorId, newId): Promise<void>`.

- [ ] **Step 1: Add the fields** — in `src/store/repository.ts`:
  - `MemoryEntry` (after `lastReferenced`): `status?: "active" | "superseded"; supersedes?: number | null; supersededBy?: number | null; parentIds?: number[];`
  - `MemorySearchOptions` (currently `{ project?; target?; category?; limit? }`): add `includeSuperseded?: boolean;`
  - `MemoryRepository` (after `bumpMemoryWorth`): `supersedeMemory(priorId: number, newId: number): Promise<void>;`
  - (All OPTIONAL on `MemoryEntry` to avoid churning test fixtures — DB `mapRow` always sets them; the ranker/search ignore undefined.)

- [ ] **Step 2: Run `tsc`** — `( cd bun-apps/pi-agent-ext-hermes-memory && bunx tsc --noEmit )`. Expected: FAIL with `supersedeMemory` missing from `SqliteMemoryRepository`/`SurrealMemoryRepository` (the expected cross-task gap — Tasks 3–4 close it; the optional `MemoryEntry` fields don't break anything). This confirms the interface landed.

- [ ] **Step 3: Commit** — `git add src/store/repository.ts && git commit -m "feat(hermes-memory): supersession types — MemoryEntry lineage + status filter option + supersedeMemory iface"`.

---

## Task 2: SQLite schema + migrations for the lineage columns

**Files:**
- Modify: `src/store/sqlite/schema.ts` (`memories` DDL), `src/store/sqlite/sqlite-backend.ts` (`ensureMemoriesColumns`, `copyMemories`, both `migrateLegacyMemoriesTargetConstraint` branches)
- Modify: `tests/store/db.test.ts` (migration test)

**Interfaces:**
- Produces: `status TEXT NOT NULL DEFAULT 'active'`, `supersedes INTEGER`, `superseded_by INTEGER`, `parent_ids TEXT` (JSON `number[]`); migrated via ALTER; both rebuild branches + corruption-heal carry them.

- [ ] **Step 1: Write the failing migration test** — add to `tests/store/db.test.ts` (mirror the existing "migrate legacy memories table" forging pattern — read it first): forge a legacy `memories` table WITHOUT the 4 columns (+ legacy `CHECK` to also exercise the rebuild path), reopen via `SqliteBackend`, assert `PRAGMA table_info(memories)` has `status`/`supersedes`/`superseded_by`/`parent_ids` and the existing row backfills to `status='active'`, `supersedes=NULL`, `parent_ids=NULL`.

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/db.test.ts )`. Expected: FAIL (columns absent).

- [ ] **Step 3: Add columns** — in `schema.ts` `memories` DDL append (before `)`): `,\n  status TEXT NOT NULL DEFAULT 'active',\n  supersedes INTEGER,\n  superseded_by INTEGER,\n  parent_ids TEXT`. In `sqlite-backend.ts` `ensureMemoriesColumns` add 4 guarded ALTERs: `if (!names.has('status')) db.exec("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");` + `supersedes INTEGER` + `superseded_by INTEGER` + `parent_ids TEXT`. In `copyMemories` (INSERT col list + params + `readTableRows` desired-cols): add the 4 columns (for `parent_ids` pass the raw string through; for `status` default `'active'` via `?? 'active'`). In BOTH `migrateLegacyMemoriesTargetConstraint` rebuild branches: add the 4 columns to `memories_new` DDL + the `INSERT INTO memories_new (…) SELECT … FROM memories` column list (TWO copies).

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/db.test.ts )`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/store/sqlite/schema.ts src/store/sqlite/sqlite-backend.ts tests/store/db.test.ts && git commit -m "feat(hermes-memory): sqlite supersession columns + migrations"`.

---

## Task 3: SQLite repo — columns on read/write + status filter + supersedeMemory

**Files:**
- Modify: `src/store/sqlite/sqlite-memory-repo.ts` (`MEMORY_SELECT_COLUMNS`, `MemoryRow`, `mapRow`, INSERTs, `searchMemories` `runSearch`, `fetchGraphNeighbors`; add `supersedeMemory`)

**Interfaces:**
- Produces: `mapRow` returns the 4 fields (with `parent_ids` JSON-decoded); INSERTs seed defaults (`status='active'`); `searchMemories` + `fetchGraphNeighbors` default to `status='active'` (override via `includeSuperseded`); `supersedeMemory(priorId, newId)` flips prior + sets new lineage (atomic pair of UPDATEs).

- [ ] **Step 1: Write the failing tests** — append to `tests/store/sqlite-memory-repo.test.ts` (bun:test): (a) `addMemory` → `mapRow` surfaces `status='active'`/`supersedes=null`/`parentIds=[]`; (b) `supersedeMemory(priorId, newId)` → prior `status='superseded'`+`supersededBy=newId`, new `supersedes=priorId`+`parentIds=[priorId]`; (c) `searchMemories` hides the superseded prior by default, surfaces it with `includeSuperseded:true`.

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-memory-repo.test.ts )`. Expected: FAIL.

- [ ] **Step 3: Wire columns + filter + method** — in `sqlite-memory-repo.ts`:
  - `MEMORY_SELECT_COLUMNS`: add `status, supersedes, superseded_by, parent_ids`.
  - `MemoryRow`: add `status: string; supersedes: number | null; superseded_by: number | null; parent_ids: string | null;`.
  - `mapRow`: add `status: (row.status || "active") as "active" | "superseded", supersedes: row.supersedes, supersededBy: row.superseded_by, parentIds: parseParentIds(row.parent_ids),` where `parseParentIds` = `try { const a = JSON.parse(raw ?? "[]"); return Array.isArray(a) ? a.map(Number) : []; } catch { return []; }`.
  - INSERTs (`addMemory` + `syncMemoryEntry` new-row): no change strictly needed (defaults apply) — BUT add `status` explicitly as `'active'` only if a test requires it; otherwise leave defaults.
  - `searchMemories`: destructure `includeSuperseded = false` from `options`; inside `runSearch` (after the FTS condition) add `if (!includeSuperseded) { conditions.push("m.status = 'active'"); }`. Pass `includeSuperseded` into `fetchGraphNeighbors` and add the SAME condition there.
  - Add `supersedeMemory`:
    ```typescript
    async supersedeMemory(priorId: number, newId: number): Promise<void> {
      return runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => {
        this.db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ? WHERE id = ?").run(newId, priorId);
        this.db.prepare("UPDATE memories SET supersedes = ?, parent_ids = ? WHERE id = ?").run(priorId, JSON.stringify([priorId]), newId);
      }));
    }
    ```

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/sqlite-memory-repo.test.ts )` then the full `tests/store/` suite (existing search tests must stay green — all rows default `active`). Confirm `bunx tsc --noEmit` (the sqlite `supersedeMemory` gap closes; only surreal remains).

- [ ] **Step 5: Commit** — `git add src/store/sqlite/sqlite-memory-repo.ts tests/store/sqlite-memory-repo.test.ts && git commit -m "feat(hermes-memory): sqlite repo supersession columns + status filter + supersedeMemory"`.

---

## Task 4: Surreal repo — FIELDS/row/mapper/SET + status filter + supersedeMemory

**Files:**
- Modify: `src/store/surreal/surreal-memory-repo.ts` (`FIELDS`, `Row`, `mapRow`, CREATE SET, `buildScope`, `searchMemories`/`fetchGraphNeighbors`/`getMemories` call sites; add `supersedeMemory`)

**Interfaces:**
- Produces: symmetric to Task 3 for SurrealDB (SCHEMALESS — `parentIds` native array; `status`/`supersedes`/`supersededBy` free fields). `buildScope` gains an optional `includeSuperseded` (default `true` = no filter, preserving mutation-path behavior); the three READ paths pass the option's value.

- [ ] **Step 1: Write the failing test** — in `tests/store/surreal-memory-repo-contract.test.ts` (gated on `isSurrealUp()`), mirror Task 3's three assertions. Skips without a Surreal instance.

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal-memory-repo-contract.test.ts )` (FAIL if Surreal up; SKIP if down).

- [ ] **Step 3: Wire Surreal** — in `surreal-memory-repo.ts`: append `, status, supersedes, supersededBy, parentIds` to `FIELDS`; add the fields to `Row` + `mapRow` (`status: r.status ?? "active"`, `supersedes: r.supersedes ?? null`, `supersededBy: r.supersededBy ?? null`, `parentIds: Array.isArray(r.parentIds) ? r.parentIds.map(Number) : []`); add `status = 'active', supersedes = NONE, supersededBy = NONE, parentIds = []` to the `addMemory` CREATE SET. Extend `buildScope` signature with `includeSuperseded = true` and `if (!includeSuperseded) conds.push("status = 'active'")`; pass `includeSuperseded` (from options, default `false`) ONLY from `searchMemories`, `fetchGraphNeighbors`, `getMemories` — NOT from `syncMemoryEntry`/`replaceSyncedMemories`/`removeSyncedMemories`/`removeExactSyncedMemories` (they keep the default `true`). Add `supersedeMemory`:
    ```typescript
    async supersedeMemory(priorId: number, newId: number): Promise<void> {
      const p = Number(priorId), n = Number(newId);
      await this.c.query(`UPDATE memories SET status = 'superseded', supersededBy = $n WHERE seq = $p;`, { p, n });
      await this.c.query(`UPDATE memories SET supersedes = $p, parentIds = [$p] WHERE seq = $n;`, { p, n });
    }
    ```

- [ ] **Step 4: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal-memory-repo-contract.test.ts )` (PASS if up; else verify by symmetry + `bunx tsc --noEmit` going fully green — the last `supersedeMemory` gap closes).

- [ ] **Step 5: Commit** — `git add src/store/surreal/surreal-memory-repo.ts tests/store/surreal-memory-repo-contract.test.ts && git commit -m "feat(hermes-memory): surreal repo supersession columns + status filter + supersedeMemory"`.

---

## Task 5: `memory_supersede` tool + index.ts mount

**Files:**
- Create: `src/tools/memory-supersede-tool.ts`
- Modify: `src/index.ts` (mount alongside `registerMemorySearchTool` ~:387)
- Modify: `tests/tools/memory-supersede-tool.test.ts` (create)

**Interfaces:**
- Produces: `registerMemorySupersedeTool(pi, memoryRepo, store, projectStore?, projectName?)` registering a `memory_supersede` tool (params: `prior_id` (number), `replacement` (string), `target`, `project`, `evidence`/`sources` optional) → creates the replacement via `store.add` + captures `memoryRepo.syncMemoryEntry` for the new id → `supersedeMemory(priorId, newId)` → verification probe (`searchMemories(priorContent)` asserts replacement present + prior absent) → returns `{ content, details: { newId, priorId, probe } }`.

- [ ] **Step 1: Write the failing test** — create `tests/tools/memory-supersede-tool.test.ts` (mirror `tests/tools/memory-tool.test.ts`'s mock-store + real-`SqliteMemoryRepository` + mock-pi scaffold): addMemory a prior → capture the `memory_supersede` tool def → execute with `prior_id` + `replacement` → assert: a new active entry exists with `supersedes=priorId`/`parentIds=[priorId]`; the prior is `status='superseded'`/`supersededBy=newId`; `searchMemories(priorContent)` returns the replacement but NOT the prior; `details.probe = { replacementPresent: true, priorAbsent: true }`.

- [ ] **Step 2: Run RED** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/tools/memory-supersede-tool.test.ts )`. Expected: FAIL (module not found).

- [ ] **Step 3: Create the tool** — `src/tools/memory-supersede-tool.ts` (mirror `memory-search-tool.ts`'s standalone registration; type-safe). Read `registerMemorySearchTool` + `syncAddToSqlite` first to match import paths + the `ExtensionAPI`/`MemoryStore`/`MemoryRepository` types. Skeleton:

```typescript
import type { ExtensionAPI } from "../index.js"; // match memory-search-tool's import
import type { MemoryStore } from "../store/memory-store.js";
import type { MemoryRepository } from "../store/repository.js";

export function registerMemorySupersedeTool(
  pi: ExtensionAPI,
  memoryRepo: MemoryRepository | null,
  store: MemoryStore,
  projectName?: string | null,
): void {
  pi.registerTool({
    name: "memory_supersede",
    label: "Memory Supersede",
    description: "Retire a stale/wrong memory by creating a linked replacement. The prior is marked superseded (hidden from search); the replacement carries lineage back to it. Use when a recalled memory is wrong and you have the correction.",
    parameters: Type.Object({
      prior_id: Type.Integer({ description: "The DB id of the memory to retire (from a memory_search result)" }),
      replacement: Type.String({ description: "The corrected memory content (becomes a new active entry)" }),
      target: StringEnum(["memory", "user", "failure"] as const),
      project: Type.Optional(Type.String()),
    }),
    execute: async (_id, args) => {
      const { prior_id, replacement, target, project } = args;
      // 1. Write the replacement to .md
      const addRes = await store.add(target, replacement, { });
      if (!addRes.success) return { content: [{ type: "text", text: `Supersede failed: ${addRes.error ?? "add failed"}` }], details: { ok: false } };
      if (!memoryRepo) return { content: [{ type: "text", text: "Replacement saved to Markdown, but no search store to link lineage." }], details: { ok: true, linked: false } };
      try {
        // 2. Sync the replacement to DB + capture the new id (do NOT reuse syncAddToSqlite — it discards the id)
        const sqliteTarget = target === "user" ? "user" : target; // match the project/memory target mapping used elsewhere
        const syncRes = await memoryRepo.syncMemoryEntry({ content: replacement, target: sqliteTarget, project: project ?? null });
        const newId = syncRes.entry.id;
        // 3. Flip lineage (prior -> superseded; new -> supersedes prior)
        await memoryRepo.supersedeMemory(prior_id, newId);
        // 4. Verification probe — searchMemories now hides the prior via the status filter
        let probe: { replacementPresent: boolean; priorAbsent: boolean } | undefined;
        try {
          const hits = await memoryRepo.searchMemories(replacement.split(/\s+/).slice(0, 3).join(" "), { project: project ?? undefined, target: sqliteTarget });
          probe = { replacementPresent: hits.some((h) => h.id === newId), priorAbsent: !hits.some((h) => h.id === prior_id) };
        } catch { probe = undefined; }
        return { content: [{ type: "text", text: `Superseded memory #${prior_id} with #${newId}.${probe ? ` Probe: replacement ${probe.replacementPresent ? "present" : "MISSING"}, prior ${probe.priorAbsent ? "hidden" : "LEAKED"}.` : ""}` }], details: { ok: true, linked: true, newId, priorId: prior_id, probe } };
      } catch (err) {
        return { content: [{ type: "text", text: `Replacement saved to Markdown, but lineage link failed: ${err instanceof Error ? err.message : String(err)}. (Recoverable — retry memory_supersede.)` }], details: { ok: true, linked: false } };
      }
    },
  });
}
```
(Adjust the `Type`/`StringEnum` imports + the target-mapping to match the codebase's exact conventions — read `memory-search-tool.ts` + `memory-tool.ts`'s imports first. The probe's search term is a 3-word slice of the replacement as a lexical handle; keep it best-effort.)

- [ ] **Step 4: Mount in index.ts** — import `registerMemorySupersedeTool` + call it next to `registerMemorySearchTool` (~:387): `registerMemorySupersedeTool(pi, memoryRepo, store, projectName);` (after `registerMemorySearchTool`; `memoryRepo`/`store`/`projectName` are in scope there).

- [ ] **Step 5: Run GREEN** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/tools/memory-supersede-tool.test.ts )` then the full `tests/tools/` + `tests/store/` + `bunx tsc --noEmit`.

- [ ] **Step 6: Commit** — `git add src/tools/memory-supersede-tool.ts src/index.ts tests/tools/memory-supersede-tool.test.ts && git commit -m "feat(hermes-memory): memory_supersede tool (replacement + lineage flip + verification probe)"`.

---

## Task 6: Shared contract test — status filter + supersedeMemory round-trip + re-sync stability (both backends)

**Files:**
- Modify: `tests/store/repository-contract.test.ts` (`runMemoryRepositoryContract`)

**Interfaces:**
- Consumes: Tasks 1–5.

- [ ] **Step 1: Write the tests** — inside `runMemoryRepositoryContract` add: (a) status filter — `addMemory` two entries, `supersedeMemory(a.id, b.id)`, `searchMemories(a's term)` excludes `a` by default + includes it with `{ includeSuperseded: true }`; (b) lineage round-trip — `supersedeMemory` sets `a.status='superseded'`+`a.supersededBy=b.id`+`b.supersedes=a.id`+`b.parentIds=[a.id]`; (c) re-sync stability — after `supersedeMemory`, re-run `syncMemoryEntry({content: a's content, …})` (the merge path) and assert `a`'s status/lineage are PRESERVED (not reset to active).

- [ ] **Step 2: Run** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository-contract.test.ts )` (SQLite); the Surreal instantiation runs the same suite when up. Fix any backend asymmetry.

- [ ] **Step 3: Commit** — `git add tests/store/repository-contract.test.ts && git commit -m "test(hermes-memory): supersession status-filter + round-trip + re-sync-stability contract (both backends)"`.

---

## Self-Review

1. **Spec coverage (07, Partial IN):** `status`+lineage fields (T1) + dual-backend columns (T2–T4) + `memory_search` defaults `active` (T3–T4) + `memory_supersede` tool (T5) + verification probe (T5) + contract (T6). The `memory_supersede` tool reuses Plan 1's `sources[]` for evidence (via `store.add` options — confirm the tool passes `sources` if evidence is provided; the skeleton omits it for brevity — add it). OUT of v1: auto-trigger (Plan 5, attribution-hard); consolidation-coupling (Plan 5); `.md` status marker (DB-only).
2. **Placeholder scan:** every code step has real code; where an import path is uncertain ("match memory-search-tool's import"), the implementer reads the reference first — named. The tool skeleton is complete; the implementer finalizes imports + the target-mapping.
3. **Type consistency:** `status`/`supersedes`/`supersededBy` (camelCase DTO) ↔ `status`/`supersedes`/`superseded_by` (snake_case SQLite); `parentIds` (DTO array) ↔ `parent_ids` (JSON string SQLite) / native array Surreal. `supersedeMemory(priorId, newId)` identical on interface + both repos.
4. **Behavior change audit:** the status filter HIDES superseded rows from `searchMemories` + `fetchGraphNeighbors` — all-active existing rows unaffected (verified: every existing test creates active rows). `getMemories` stays unfiltered. No ranking change (superseded rows don't enter the candidate pool).
5. **Safety:** the tool is best-effort (partial-failure documented); `supersedeMemory` uses UPDATE (id stable); the probe is single-process.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-29-hermes-memory-supersession.md`.

**Two execution options:**
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between.
2. **Inline Execution** — execute in this session via executing-plans.

**Which approach?**

This is **Plan 4** — the agent-driven supersession mechanism (the largest Tier-1 piece). With it, the agent can retire stale memories (`memory_supersede`), superseded entries hide from search, and a probe verifies the flip. **Plan 5 (next)** = the auto-trigger (correction→supersede, needs attribution research) + consolidation-lineage-preservation + (optionally) clone-durable stable-id lineage. This closes the Tier-1 roadmap from the wayfinder spec.
