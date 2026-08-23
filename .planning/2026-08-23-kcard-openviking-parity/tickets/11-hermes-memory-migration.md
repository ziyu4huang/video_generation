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
