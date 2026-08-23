# 11 — hermes memory migration into `user_<ns>/`

type: task
blocked by: 01 (D7 default flip; amended by this ticket)
added: 2026-08-23 (user directive, same session as ticket 02 close)

## Question

Amends D7's "no auto-migration" clause: the user wants current hermes memory data migrated/consolidated into the per-user namespace scheme (`user_<ns>/memory`), not left behind in divergent sqlite copies when SurrealDB becomes the default.

## Measured context (2026-08-23, this machine)

- `~/.pi/agent/hermes-memory-config.json` = `{ "dbBackend": "surrealdb" }` — the local instance ALREADY runs surreal; the live store is ns `user_huangziyu` / db `memory` (D6-compliant naming already in production here).
- Divergent copies (NOT a clean one-way migration — a reconciliation):
  - **live surreal** `user_huangziyu/memory`: memories **3599**, sessions **5287**, messages **57012** (schema tables + `hermes_en` analyzer present).
  - **`~/.pi/agent/pi-hermes-memory/memory.db`** (sqlite): memories **3549**.
  - **`~/.pi/agent/pi-hermes-memory/sessions.db`** (sqlite): memories **1381**, sessions **3549**, messages **35480**, `card_md_hash` 50.
  - Plus `~/.pi/agent/_backup_mem_20260627-221044/sessions.db` (older backup) and `pi-hermes-memory/_backup_*` md-era backups.
- Surreal is AHEAD on sessions/messages (it has been the live backend for a while); sqlite memory.db may hold rows surreal lacks (3549 vs 3599 overlap unknown).

## Scope (build ticket — lands with the post-to-spec build plan)

1. One-time reconciliation tool: read both sqlite copies, upsert into `user_<ns>/memory` **dedup by the schema's UNIQUE keys** (`mdId` — `memories_md_id UNIQUE` index; sessions by id), never deleting live surreal rows; report per-table `created/updated/unchanged/skipped-dup` counts.
2. Verification gate (D14 applies): post-migration count + spot-check diff (per-mdId presence check both directions; A/B recall smoke on the migrated store vs pre-migration surreal) + independent reviewer subagent.
3. After gate passes: leave sqlite files in place as named backups (rename with `.migrated-<date>` suffix so a stale db is never silently picked up again); update the `_backup_*` dirs' README or map note.
4. Idempotent + re-runnable (a crash mid-migration must be safe to retry — upserts keyed on unique ids).

Out of scope: kcard's `context_db` (empty, fresh — nothing to migrate); md-era backups older than the sqlite pair; any online/remote stores.

## Resolution (2026-08-23, BUILT + EXECUTED same day — CLOSED)

**D7 status found already shipped in code**: `config.ts:106` DEFAULT_CONFIG is `dbBackend: "surrealdb"` with `createBackendBundleWithFallback` transparently falling back to sqlite on init failure (tested, `tests/store/backend-factory.test.ts`). The residual `?? "sqlite"` literals are config-less-construction defaults only. Nothing to flip.

**Deliverable**: `bun-apps/s2-agent-ext-hermes-memory/scripts/db-transfer.ts` — one two-way reconciliation script (`--to-surreal` / `--to-sqlite`, `--dry-run`, `--json`), insert-only by construction (never deletes/overwrites a live destination row). memories ride the repos' `addMemory` (C6 identity dedup) + a post-create **fidelity UPDATE** restoring status/supersession lineage, parentIds, mw counters, pin, severity (addMemory's input cannot carry them — without it a `superseded` source row would resurrect as active). Content-diverged mdId pairs keep BOTH live versions (skip, never overwrite). Other tables are raw row copies keyed on natural keys. SurrealQL traps honored (no record-id `IN`, ORDER BY-stable pagination, batch-failure row replay with already-exists → skipped). Allowlisted in scripts-dir-contract; `scripts/**` added to the package tsconfig; 11 helper tests (`__tests__/db-transfer.test.ts`).

**Correction to the measured context above**: the `memory.db` 3549-memories figure was a probe misread (adjacent output of sessions.db's sessions count). `memory.db` was a 0-byte artifact accidentally created by the probe's `sqlite3` open and removed — it never contained data. Only `sessions.db` carried data. The `.migrated-<date>` rename step is DROPPED: with two-way transfer established, the sqlite fallback stays in place and is kept FRESH by reverse sync, not frozen.

**Execution results (live, 2026-08-23)**:

| direction | memories | sessions | messages | session_files |
|---|---|---|---|---|
| to-surreal (rescue fallback-era rows) | +394 (37 mdId-diverged skipped) | +130 | +131 | 0 |
| to-sqlite (refresh fallback) | +2604 | +1875 | +21690 | +1068 |
| idempotent re-runs (both) | 0 created / 0 failed | 0 | 0 | 0 |

Post-migration: surreal 3988 mem / 5424+ sess / 57170+ msg; sqlite 3975 / 5424 / 57170 — sessions/messages byte-identical counts; the 13-memory gap = content-diverged mdId pairs kept on both sides by design. Convergence proven by dry-runs reporting 0 pending both directions; a live agent session writing during the run was picked up by the reverse sync (5 rows), demonstrating the two-way cadence works.

**D14 gate**: A/B = the convergence dry-runs + count tables above (baseline: pre-migration counts measured this session). Reviewer = independent subagent review, verdict FIX-FIRST → all findings resolved: supersession-lineage fidelity UPDATE (was: resurrect-as-active), messages now carry denormalized project/cwd (project-filtered session search), `usedAt` null → field omitted (NONE semantics), batch-replay already-exists → skipped (truthful re-runs), ORDER BY-stable pagination, JSON-tuple identity key, dead code removed; memory.db finding closed as a measurement artifact (corrected above); superseded `.migrated-` rename replaced by the reverse-sync cadence. Re-run after fixes: 0 failed both directions.
