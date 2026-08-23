# Plan: hermes-memory startup sync — Surreal transactional batching

**Date:** 2026-07-31 · **Branch:** `wip/next` (SDD, squash-merge to main) · **Diagnosis:** `.planning/2026-07-31-why-startup-s2-agent-sh-so-slow/map.md`

## Context — the diagnosed root cause

`./pi-agent.sh` startup is ~10.6s; 91% is I/O wait. CPU profile + `~/.pi/agent/pi-hermes-memory/perf.jsonl` attribute **~all of it to one op**: `startup.syncMarkdownMemories` (`src/index.ts:192`), on the active **`surrealdb`** backend. Latest record: **317 HTTP round-trips / 6295ms**, growing with memory size.

Round-trip attribution (read from `src/store/surreal/surreal-memory-repo.ts`):
- `getMemories()` = **1** round-trip (single SELECT). Fine.
- `syncMemoryEntry()` = **2-3+** round-trips each (SELECT + UPSERT + `syncGraphEdges` tag UPSERTs), called once per *dirty* entry.
- ⇒ 317 rt ≈ 1 + ~150 dirty entries × ~2 rt. Each localhost rt costs ~20ms (not ~2ms — multiple statements + graph edges per entry).

A prior optimization (**PR #909**) already added batch-fetch (`buildExistingIndex`, 1 rt) + skip-no-op (`mergeIsNoOp`). It is **live but insufficient**: `mergeIsNoOp` requires `existing.lastReferenced >= incoming.lastReferenced`, and recalls bump the `.md` entry's `last=`, so any entry recalled since the last sync looks "dirty" and re-syncs every boot. The skip helps only never-recalled entries — a shrinking set under active use.

## The fix

**Collapse the N serial per-entry round-trips into ONE batched Surreal transaction.** `SurrealClient.query()` already sends a `;`-separated statement batch as a single HTTP POST (the /sql endpoint processes each statement independently), and the 5c supersedeMemory path (`surreal-memory-repo.ts:556`) already proves the `BEGIN TRANSACTION; …; COMMIT TRANSACTION;` batched-script pattern. Reuse it for the startup sync: build one script containing every dirty entry's UPSERT + graph edges, send via one `query()` → **1 round-trip** instead of ~317. Expected: **6.3s → <100ms**, regardless of how many entries are dirty.

`skip-unchanged` (B) becomes an *optional* refinement once the batch lands — see Task 2's tradeoff.

## Tasks (TDD, dual-backend parity: SQLite + Surreal contract tests)

### Task 1 — `syncMemoryEntriesBatch`: one transactional round-trip for N dirty entries

**Red.** Contract test (surreal): given the existing index + a list of N (e.g. 50) *changed* entries, `syncMemoryEntriesBatch(...)` persists all of them AND the perf `roundTrips` counter increments by **≤ 2** (1 for the batched script; allow 1 slack), not ~N×2. Assert every entry is upserted with merged fields and graph edges built.

**Green.**
- Add `syncMemoryEntriesBatch(existingByContent, incoming: ParsedEntry[]): Promise<{ inserted, updated, skipped }>` to `MemoryRepository` (backend-neutral interface).
- **Surreal impl:** build a single `BEGIN TRANSACTION; <for each dirty entry: UPSERT … ; syncGraphEdges inline>; COMMIT TRANSACTION;` script; send via one `this.c.query()`. Reuse the existing UPSERT + edge logic from `syncMemoryEntry`, hoisted into statement builders. Respect the perf `roundTrips` counter (one bump for the whole batch).
- **SQLite impl:** wrap the per-entry loop in a single `transaction(() => …)` (better-sqlite3 nested tx) for parity; SQLite is already fast locally, so this is mostly interface parity + a small win.
- Keep `syncMemoryEntry` (single) for the command path / non-batch callers.

**Refactor.** Extract the UPSERT-statement + graph-edge-statement builders shared between the single + batch paths.

**Acceptance:** N dirty entries sync in ≤2 Surreal round-trips; both backends pass contract tests; `bun test` green.

### Task 2 — (optional, evaluate) tighten `mergeIsNoOp`: content-stable = no-op

**Tradeoff to weigh before doing this:** the DB orders `getMemories()` by `lastReferenced DESC` (recall ranking). Treating `lastReferenced`-only changes as no-ops stops re-syncing them → **the DB's `lastReferenced` goes stale → that ordering drifts.** With Task 1 landed, the batch is cheap even for all-dirty entries, so this task's value shrinks to "smaller batch script on huge vaults."

**Recommendation:** likely **defer** unless Task 1's batched script size becomes a problem (very large vaults). If pursued:

**Red.** Unit test: an incoming entry differing from the stored one *only* in `lastReferenced` → `mergeIsNoOp` returns `true` (skipped). An entry differing in `content`/`category`/`created` → `false`.

**Green.** Drop the `exL >= inL` clause from `mergeIsNoOp`; keep the content/created/category/failureReason checks. Document the staleness consequence on `getMemories` ordering.

**Acceptance (if pursued):** lastReferenced-only entries skip; content changes still sync; ordering-staleness documented as accepted.

### Task 3 — wire batched sync into `syncMarkdownMemories` + perf gate

**Red→Green.**
- In `syncMarkdownMemories` (`src/handlers/sync-markdown-memories.ts`): after `buildExistingIndex`, partition entries into **no-op** (skip) vs **dirty**; pass the dirty list to `syncMemoryEntriesBatch` instead of looping `syncMemoryEntry` per entry. Preserve `BackfillCounters` (inserted/updated/skipped).
- **Perf gate (manual + assert):** run `bun src/cli.ts --list-models` (the repro from the diagnosis) before/after; confirm the fresh `startup.syncMarkdownMemories` perf.jsonl record drops to **≤ ~5 round-trips / < 1000ms** (was 317 / 6295ms). Add a regression-style assertion or a documented measurement step in the plan-execution checks.

**Acceptance:** startup `--list-models` wall time drops from ~10.6s to <1s; perf.jsonl `startup.syncMarkdownMemories` round-trips ≤ ~5; `bun test` green; `tsc --noEmit` clean; dual-backend contract tests pass.

## Out of scope (follow-ups)

- **D — 120s lock-contention** (`fileLock.hold.memory` / `consolidation.memory` `timedOut` under concurrent sibling agents sharing one Surreal backend): a separate effort — investigate `fileLock` fairness, the 120s ceiling, and per-agent Surreal namespacing.
- **C — defer sync off the boot critical path** (background/lazy): UX follow-up; only worth it if even the batched <100ms is felt, or for very large vaults.
- The launcher (`run.sh`/`pi-agent.sh`) — exonerated (~44ms).
- Re-implementing PR #909's batch-fetch/skip — already shipped; this plan builds *on top of* it (batch the remaining dirty syncs).
