# 06 — Tame the SQLite disk-I/O noise

## Question

The convergence / memory-write read path intermittently throws transient
`SQLITE_IOERR` ("disk I/O error") under multi-process WAL load (singleton +
`pi -p` children + `/memory-index-sessions` share one `sessions.db`). It is
**benign** (transient contention, not corruption; bypasses corruption-recovery,
next write succeeds) but the noise **undermines trust** in convergence output.
**How do we make it stop undermining trust?**

### Context (pre-gathered)

PR #648 added `isTransientDbError` + `runWithTransientRetry` to the **live-index
path** + `pruneStaleBackups`. The **memory-tool WRITE path** and the
**convergence READ path** (auto-converge hook) lack the retry — confirmed in the
2026-07-18 memory entry ("FOLLOWUP: the memory-tool write path ALSO shows this
DB-sync flake… retry not yet applied there").

### Candidates

- **(a) Extend the retry.** Apply `runWithTransientRetry` to the convergence +
  memory-write paths — same fix as #648, pragmatic, makes the flake self-heal.
- **(b) Suppress the warning.** Downgrade the noisy `SQLite search sync failed:
  disk I/O error` log so a transient retry is silent; a real (non-transient)
  failure stays loud.
- **(c) Both** — retry + log-downgrade so transients vanish and reals surface.

### Decide

- Scope: is this "make the noise go away" (cosmetic + retry) or "make the read
  path actually robust" (retry + connection/serialization discipline)?
- Does retry belong in the shared DB layer (so every caller inherits it) or
  per-callsite? (The memory entry notes the write-path flake is the same root
  cause — argues for the shared layer.)

type: grilling
claimed: wayfinder-session
blocked by: —
status: closed

## Resolution (closed this session)

**Push `runWithTransientRetry` INTO the shared store; exhaustion stays loud.**

**Finding — T06 premise partly stale** (verified against merged code):
- PR **#633** (merged 2026-07-18 05:15) already added `runWithTransientRetry` +
  `isTransientDbError` to `src/store/db.ts` (the shared primitive) and applied it
  to the **memory-tool write path** (all 3 sync sites) + the **session-live-index
  path**. `busy_timeout=5000` is set per connection.
- The **convergence path** (`pi-agent-ext-knowledge-card` → `ingest.ts`/
  `loop.ts`) is **filesystem-only** — it reads `.md` via `readFileSync`/
  `readdirSync` + `adaptHermesMarkdown`. It never opens `sessions.db`. So
  "the convergence READ path lacks retry" was a **premise error**: there's no
  SQLite read there to flake.
- The 2026-07-18 memory entry ("memory-tool write path ALSO shows the flake…
  retry not yet applied there") is **stale** — #633 applied it the same day.

**Surviving gap (the real flake sources):** the retry is per-callsite, and 3
write callers were missed:
- `grill-decision-tool.ts:143` (`syncMemoryEntry` — the grill_decision tool)
- `review-memory-ops.ts:234/247/262/276` (4 sites)
- `correction-detector.ts:251`

**Decision — push `runWithTransientRetry` INTO the shared store**
(`sqlite-memory-store.ts`): wrap the internals of `syncMemoryEntry` /
`replaceSyncedMemories` / `removeSyncedMemories`. Every caller inherits retry;
the per-callsite scatter that let #633 miss those 3 is gone **permanently**.
Exhaustion stays **loud** (3 × 5s `busy_timeout` = 15s patience → a failure
after that is genuinely real, not transient contention). Candidate (b)
log-downgrade is **unnecessary**.

**Build note:** the sync fns are currently sync (callers pass them to async
`runWithTransientRetry`). Pushing retry inside has two paths —
- (i) make the fns **async** (all callers `await`; larger blast radius), or
- (ii) add a sync **`withTransientRetrySync`** variant (immediate retries, no
  async backoff — relies on `busy_timeout=5000` for the waiting; smaller blast
  radius, fits because `SQLITE_IOERR` is a momentary blip, not lock contention
  that benefits from backoff).
Recommend **(ii)** unless async-ifying is cheap. The redundant per-callsite
wraps in `memory-tool.ts` can stay (harmless double-retry) or be removed.

**No new tickets; does not graduate fog.**
