type: research
status: closed (2026-07-20)
claimed: charting-session
blocked by: —

## Question

What cross-process locking architecture should back the "reduction is safe while sessions are live" goal? Three candidates:

1. **Advisory lockfile on the `.md`** (`proper-lockfile` or equivalent) — keep `.md` as source-of-truth, wrap the `loadFromDisk → mutate → saveToDisk` critical section (and `dedup.sh`'s trim) in a cross-process lock.
2. **Migrate to SQLite-WAL as source-of-truth** — make the `memories` DB authoritative, `.md` a derived/exported view; rely on WAL's native multi-process concurrency.
3. **Best-effort lockfile, graceful degradation** — lock when possible, no hard guarantee (doesn't fully solve the lost-update, just narrows the window).

Also: what's the mixed-version rollout story (old sessions that don't take the lock)?

## Resolution

**Recommend #1 — `proper-lockfile` advisory lock on the `.md`.** Closed.

Findings (web research + local code read):

- **`proper-lockfile`** (npm, MIT, moxystudio) is an inter-process **and** inter-machine lockfile utility, works on local + network FS, pure JS. Safe under Bun. Stale-lock detection built in. This is the canonical Node/Bun cross-process lock — no native `flock` binding needed (macOS doesn't ship `flock(1)`; relying on it would be non-portable). Acquisition is async, fits the existing `async _addInner`/`saveToDisk` shape.
- **SQLite-WAL (#2)** is architecturally cleaner for concurrency (WAL + shm give real multi-writer/multi-reader isolation), but it inverts the source-of-truth: the `.md` becomes a derived export, and the human-editable `.md`-first model (which `dedup.sh`, manual edits, and the skill all depend on) breaks. That's a large, risky migration touching the skill + every writer. Overkill for a single-user, ~18-worktree machine. **Reject for now** — revisit only if the `.md`-source model itself becomes unsustainable.
- **Graceful degradation (#3)** doesn't deliver the destination guarantee ("safe while sessions live"); it only narrows the race. Reject.
- **Mixed-version rollout**: a new advisory lock only protects once *every* writer honors it. On this single-user box all worktrees pull the same extension, so a **big-bang rollout** is acceptable (one rebuild + restart of all sessions). This is a real decision for the user → spun out as ticket 03.

**Lock surface (for the build hand-off):**
- `MemoryStore`: wrap the `runExclusive` critical section's disk touch (`loadFromDisk` → array mutate → `saveToDisk`) in `proper-lockfile.lock(<mdPath>, { stale: 10s })`, release in `finally`. One lock per target file (`MEMORY.md`, `failures.md`, `USER.md`, project files).
- `dedup.sh --commit`: acquire the same lockfile (via a tiny Node/Bun shim that calls `proper-lockfile`, or `flock`-equivalent) around the `.md`-trim + DB-delete. Must use the **same lock path** the store uses, or it's a no-op.
- Keep `runExclusive` (in-process) **under** the cross-process lock — two locks, outer cross-process, inner in-process.

Hand-off note: the actual wiring is build work (past this map's edge). Ticket 03 must close first (rollout decision); then the way to the build is clear.
