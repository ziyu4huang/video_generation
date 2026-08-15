## Question

What does **"repeatable"** mean for a workflow-pack run — same inputs produce versioned/comparable outputs, idempotent overwrite, or append — and how do repeat runs relate to the `runs/` history and output naming?

type: grilling
status: closed
claimed: work-session (2026-07-19)  — override of one-ticket-per-session at user request; 08 dependency is lighter than the edge implies (run-version ≠ pack-version)

blocked by: 05(closed), 08

## Context

The destination requires "MAKE REPEAT run workflow-pack become possible." Decide the semantics: does re-running a pack with identical inputs (a) produce a new timestamped/versioned output set under `outputs/` (comparable across runs), (b) overwrite idempotently, or (c) append to history only? Decide output naming convention (ties to 05's output policy + 08's version). Decide how a run identifies its inputs (content hash?) so "repeat with same inputs" is even detectable. This is what turns a one-off script into a re-runnable unit.

## Resolution

**Default = timestamped append; same-inputs = always-run + content-hash tag.**

1. **Default output mode — timestamped append.** Each run writes `outputs/<ISO-ts>/` (alias `outputs/<runId>/`); `runs/` accumulates ALL run history (append-only); nothing overwritten; runs comparable across time. `io.outputs.naming: "timestamped"` is the default (the default value of 05's enum).

2. **naming enum semantics (defining 05's vocabulary):**
   - `timestamped` *(default)* — `outputs/<ISO-ts>/` per run.
   - `versioned` — `outputs/<vN>/` sequential + a `latest` pointer; explicit comparable versions.
   - `overwrite` — `outputs/` replaced each run (idempotent); leanest disk; prior outputs lost (history only in `runs/`).

3. **Same-inputs detection — always-run + content-hash tag.** Every run **executes fully** (predictable, reproducible — NO cross-run short-circuit). Each run is tagged with a content hash of its resolved inputs (string dir/glob → hash resolved dir contents; named slots → hash each slot). `outputs/<ts>/` + `runs/<runId>.json` carry the input-hash so runs group/compare by identical inputs. Cross-run cache-hit short-circuit = **future opt-in** (would fight the always-reproducible model) → parked in the map's *Not yet specified*.

4. **runs/ relation.** Each run → one `runs/<runId>.json` (the existing persisted-run-state, now pack-local per 03). `outputs/<ts>/` ↔ `runs/<runId>.json` cross-reference via runId + input-hash. Repeat runs never mutate/delete prior entries; pruning is the clean/purge surface's job (06).

**Domain sharpening (for CONTEXT.md via 15):** "version" is overloaded — **pack-version** (manifest `version`, 08's scheme) vs **run-version / output-version** (per-run output identity, this ticket). The `versioned` naming mode is the LATTER.

**Deferrals:** pruning old `outputs/<ts>/` + `runs/` retention → 06; the hashing mechanic + where input-hash lands in the run record → execution (14 tests it); `versioned` numbering rule (sequential vs content-addressed) + `latest` pointer form → execution.
