## Question

How does the engine **expose on-disk intermediates** (decided in 04) — naming, when written, when purged, opt-in vs always-on — **without breaking the determinism/resume invariant**?

type: prototype
status: closed
claimed: work-session (2026-07-19)  — work-through, frontier #1 ("continue")

blocked by: 05(closed), 06(closed)

## Context

04 decided intermediates hit disk (cleanability requires it), but today the engine keeps intermediate work in **script variables** precisely so runs are reproducible and resume replays the unchanged prefix. Persisting intermediates to disk tensions that invariant (see "Not yet specified" on the map). Decide: are on-disk intermediates an **opt-in** manifest flag (default off, preserving current determinism) or always-on for packs? How are they named (phase/agent-index?), and does the journal ignore them for resume? Coordinate with 06's purge policy (intermediates purged aggressively, outputs kept). Keep resume correctness provable.

## Resolution

**Journal-canonical + disposable mirror; opt-in materialization (default off).**

The resume invariant depends on the **journal** (`PersistedRunState.journal: {index, hash, result}[]`, durable in `runs/<runId>.json`). On-disk `intermediate/` files are a **MIRROR** of journal results — for inspection, cleanability, and run-state-JSON leanness. The journal is NEVER replaced by the mirror → resume correctness is provable, and purging the mirror is always safe. **No determinism tension exists** (the fog's premise — "intermediates live in script variables" — is sharpened: they live in the journal, which is already on disk; the mirror is additive, not substitutive).

**D1 — opt-in (default off).**
- Default packs: behavior unchanged (intermediates stay inline in the journal; `intermediate/` stays empty; determinism untouched).
- A pack wanting inspectable/cleanable intermediates sets `io.intermediate.persist: true` (manifest); the engine materializes each intermediate as a side-effect of the `agent()` call.
- CLI override: `workflow pack run <name> --intermediates` forces materialization per-run (default off).
- Rationale: on-disk intermediates are a CAPABILITY (destination framing); the determinism invariant is paramount; no storage/IO overhead for packs that don't need it. A default pack's `clean --scope intermediate` (06) is simply a no-op.

**D2 — naming.** `intermediate/<phase>/<callIndex>-<callHash>.<ext>`: `<phase>` (from `PersistedAgentState.phase`/`phase()`), `<callIndex>` + `<callHash>` = the SAME index+hash the journal keys on (auditable mirror↔journal link, dedupes identical re-runs), `<ext>` content-derived (`.md`/`.json`/`.txt`, fallback `.bin`).

**D3 — when written.** Side-effect of the `agent()` call completing, right after the result is journaled. Write-once per (callIndex, callHash) — a replayed prefix (journal hit) does NOT re-materialize (cached result reused, mirror file already exists). Idempotent + journal-tied.

**D4 — purge safety (strengthens 06).** `clean --scope intermediate` deletes mirror files; the journal is untouched → resume unaffected → provably safe. This is WHY 06's "intermediate = 🟢 safe tier" holds: mirror disposable, journal canonical. `purge-after-run` (06 vocab) is safe for the same reason.

**Deferrals:** large-intermediate storage optimization (content-addressed store / journal-stores-reference) → explicitly OUT (would break purge-safety, and is a separate journal-bloat concern, not on this route); mirror file format for non-text results → execution (14).
