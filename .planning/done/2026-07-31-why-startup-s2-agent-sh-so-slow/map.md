> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Diagnosis: why `./pi-agent.sh` startup is slow

## ✅ RESOLVED — PR #971 (squash `9b14d14f` on main, 2026-07-31)

**Primary fix (the 10s) shipped:** `syncMemoryEntriesBatch` collapses the ~317 serial Surreal round-trips into ONE batched `BEGIN TRANSACTION…COMMIT` script = **≤2 round-trips** (1 existence SELECT + 1 batched tx). Contract-test-proven on live SurrealDB; 879/879 tests green. Single `syncMemoryEntry` delegates to the batch on both backends (one shared impl). Plan Task 2 (skip-tighten) deferred — not needed (batch is cheap).

**Fast-follow (same-week, non-blocker):** add a MIXED-batch contract case (pre-insert ~half, then batch the full set — the realistic boot shape; untested but verified-correct on inspection + the per-entry fallback degrades to slow-boot-not-corruption).

---

## Destination

**No wayfinder map needed** — the root cause is clear (a perf bug, not fog). This file records the diagnosis + fix directions so the finding persists. Charted 2026-07-31; the skill says: if no fog surfaces, skip the map and proceed to a fix.

## TL;DR

Startup wall time = **10.6s**, of which **~10s is one operation**: the **hermes-memory** extension's `startup.syncMarkdownMemories` (`bun-apps/pi-agent-ext-hermes-memory/src/index.ts:192`). It syncs every `.md` memory into **SurrealDB** at boot, **serially, several HTTP round-trips per entry**. The active backend is `surrealdb`; round-trip count tracks memory size and is **growing** (77 → 317 over 2 days). Secondary pathology: concurrent sibling agents share the backend → `fileLock`/consolidation hit **120s timeouts**.

## Evidence

- **Freshness**: `pi-agent.sh` (symlink → `bun-apps/pi-agent/run.sh`) identical on origin/main; the 5-behind commits are unrelated. Safe.
- **Stage breakdown** (`/usr/bin/time`): bun bare 0.003s · `check-deps.ts` pre-flight 0.024s · **`bun src/cli.ts --list-models` 10.59s** · full `./pi-agent.sh` 10.64s. ⇒ the wrapper adds ~44ms; the cost is **inside pi's boot**.
- **Wall vs CPU**: `real 10.60 / user 0.59 / sys 0.34` → **91% is I/O wait**, not transpile/compute.
- **CPU profile** (`bun --cpu-prof`): `10040ms` in `timed (perf.ts:141)` ← `index.ts:192` → **`perf.timed("startup.syncMarkdownMemories", …)`**.
- **perf.jsonl** (`~/.pi/agent/pi-hermes-memory/perf.jsonl`), backend=`surrealdb`:

  | date | round-trips | ms |
  |---|---|---|
  | 07-29 | 77 | 1262 |
  | 07-30 12:17 | 197 | 3797 |
  | 07-30 14:00 | 145 | 2763 |
  | 07-30 20:11 | 95 | 2029 |
  | **07-31 14:42** | **317** | **6295** |

- **120s monsters** (last perf.jsonl records): `fileLock.hold.memory` 120027ms, `consolidation.memory` 120005ms `timedOut:true` — concurrent-agent lock contention.
- **Backend sharing**: all 4 worktrees (memory/subagent/file2md/superpowers) have no local `.pi` DB → all hit the shared `~/.pi/agent` Surreal namespace.

## Root cause

1. **`syncMarkdownMemories` (primary, the 10s):** on every boot it walks every `.md` memory and upserts into SurrealDB, **one logical op = several HTTP round-trips, serialized**. With ~N entries → 317 rt → 6.3s (measured up to 10.6s under contention). Count grows with the vault; will keep climbing.
2. **Lock contention (secondary, the 120s):** multiple pi-agents sharing one Surreal backend + the cross-process `fileLock` block each other; holds time out at the 120s ceiling.

## Fix directions (clear; pick via a small plan, not a map)

- **A — Batch the sync round-trips.** Collapse the N serial HTTP ops into Surreal batch / `BEGIN TRANSACTION` (the 5b/5c `runExclusive`+transactional pattern already exists for `supersedeMemory`; reuse it for sync). Biggest single win.
- **B — Skip-unchanged sync.** Hash/mtime-cache entries; steady-state boot does ~0 round-trips when nothing changed. Largest steady-state win; composes with A.
- **C — Move sync off the boot critical path.** Defer to background / lazy so the TUI is interactive immediately. UX win; needs care with read-after-write ordering.
- **D — Lock-contention / 120s ceiling** (separate issue): investigate `fileLock` fairness, whether the 120s timeout is appropriate, and whether concurrent agents should use distinct Surreal namespaces.

## Out of scope

- phase-2 / 5d stable-id work (separate efforts).
- The launcher (`run.sh`) itself — exonerated (44ms).
