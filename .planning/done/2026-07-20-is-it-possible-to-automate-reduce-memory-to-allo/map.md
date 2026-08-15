---
status: complete
---

> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Map — Concurrent-safe, self-reducing pi memory

## Destination

All memory targets (`memory` / `failure` / `user` / `project`) **never reject a durable write — `add` OR `replace` — due to capacity**: overflow is handled automatically and reliably, so a write always succeeds. Any capacity-reduction operation (consolidate / vault-offload / dedup) is **safe to run while agent sessions are live**, via a cross-process lock on the `.md` source-of-truth. `dedup` stays a **manual, occasional deep-clean** — no auto-trigger (the reliable auto-reduce on every overflow *is* the automation).

Priority targets: `memory` (99%) and `failure` (near-full) first; the fix is uniform across all targets.

## Notes

- **Domain**: `bun-apps/pi-agent-ext-hermes-memory/` (the `MemoryStore`, `_addInner`/`replace`/`vaultOffloadAndAdd`, `syncMemoryEntry`) + the `pi-memory-bulk-dedup` skill (`~/.pi/agent/pi-hermes-memory/skills/pi-memory-bulk-dedup/dedup.sh`).
- **Skills every session should consult**: `grilling`, `domain-modeling`, `pi-memory-bulk-dedup` (its Architecture note: `.md` is source-of-truth, DB is a hydrated index).
- **Standing prefs**: Bun-only (never node/npm); squash-merge + ship-on-green; honesty-over-face-saving (deliver the proof, even if it kills a hypothesis); terse, plan-first.
- **Key facts already established (charting session)** — don't re-litigate:
  1. `add()` already auto-consolidates on overflow (config default `memoryOverflowStrategy: "auto-consolidate"`, consolidator IS wired at `index.ts:203`). It is **flaky**: one LLM-consolidation retry, then hard `memoryFullError`.
  2. `replace()` has **NO overflow path** — it hard-rejects on full. This is the concrete gap behind the rejections that prompted this map.
  3. `vaultOffloadAndAdd` = deterministic FIFO evict-oldest → writes `tmpdir()/pi-memory-archive/*.knowledge.jsonl` (recoverable later via `zk_ingest` into the vault — **not a delete**).
  4. **No cross-process lock exists.** `MemoryStore.runExclusive` (AsyncLocalStorage) serializes only *within* one session. The dedup-concurrency risk is a classic **lost-update on the `.md`** across processes.
  5. **The DB is NOT bloated.** `<global>` memory = 16 rows (14 `.md` entries + 2 stale from a `replace`); the other ~110 rows are legitimate *project-scoped* memories across ~18 worktrees. DB-row reconciliation is out of scope (see below).

## Decisions so far

- [Lock architecture survey](tickets/01-lock-architecture-survey.md) — **`proper-lockfile` advisory lock on the `.md`** (keep `.md` as source-of-truth; SQLite-WAL-source rejected as overkill for single-user). Lock surface sketched for the build hand-off; SQLite migration reserved as a future effort only if the `.md`-source model breaks.
- [Overflow strategy](tickets/02-overflow-strategy-vault-offload-vs-layered.md) — **(B) layered**: `auto-consolidate` primary, `vault-offload` guaranteed floor → a write never hard-rejects on overflow. `replace()` gets the same layered path (it currently has none).
- [Lock rollout](tickets/03-lock-rollout-backwards-compat.md) — **(A) big-bang**: one PR (lock in `MemoryStore` + `dedup.sh`) + rebuild + restart all sessions; no graceful/opt-in mode.

## Not yet specified

- **Stale in-process capacity counter.** The skill notes that after `.md`+DB cleanup, the *running* agent's `memory add` still reports the target full (in-process counter) until restart. Once the lock work lands and external `.md` mutation becomes routine, this may graduate into a ticket (refresh/void the counter on `loadFromDisk`, or just document the restart). Not sharp enough to ticket yet.
- **vault-offload sink direction.** Today evictions land in a *temp* `.knowledge.jsonl` for manual `zk_ingest`. Once the overflow-strategy decision (ticket 02) lands, revisit whether evictions should flow **directly** into the Obsidian vault (auto-`zk_ingest`) instead of temp-then-manual. May graduate from 02.

## Out of scope

- **DB-row reconciliation.** The 126-row figure was the sum across all project scopes, not bloat; `<global>` memory has only 2 stale rows (trivial). This is a *search-quality* concern, not a *capacity* concern, and the destination is about capacity/concurrency. Re-opens as a fresh effort only if search dedup becomes a real problem.
- **Raising the per-target char limit / auto-TTL eviction.** Ruled out by choosing destination (A) — the goal is reliable *reduction*, not a bigger bucket. (`memory transfer` to the vault remains the manual escape valve for verbose-but-durable entries.)
- **Auto-triggering dedup** (capacity-threshold hook, session-end hook). Ruled out by destination Q2 — reliable auto-reduce on overflow is the automation; dedup stays manual-but-safe.
> Closed 2026-08-15: all 3 tickets closed; capacity-safe writes shipped (lock + vault-offload).
