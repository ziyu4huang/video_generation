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
blocked by: —
status: open
