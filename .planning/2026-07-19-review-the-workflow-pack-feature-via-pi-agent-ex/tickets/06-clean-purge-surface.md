## Question

What does the **agent call** to inspect / clean / purge a pack's state, and what is the **retention policy** (keep last-N runs, keep successes only, purge-on-success, purge intermediates aggressively while keeping outputs)?

type: prototype
status: closed
claimed: work-session (2026-07-19)  — work-through on the EXISTING map; the chart-the-map wrapper + the `.planning/2026-07-19-06-purge-purge-12/` effort dir are paste artifacts (06 already lives here as a frontier ticket; blocker 05 closed)

blocked by: 05(closed)

## Context

State is pack-local now (03, 04). The agent needs a model-callable surface — a new `workflow` sub-command (e.g. `workflow pack clean <name> [--keep N] [--purge intermediate|outputs|runs|all]`), a manifest-driven contract the agent reads, or both. Decide the retention defaults and how `dryRun` / confirmation works (HITL — purging history is destructive). Reuse `RunPersistence.delete` semantics where applicable. Must clearly distinguish purging *intermediates* (safe, aggressive) from purging *runs/history* (lossy) and *outputs* (maybe wanted).

## Resolution

**Safe-by-default; minimal `all`+`last-N` retention vocab.**

1. **Default philosophy — safe-by-default.** Bare `clean` purges ONLY `intermediate/` (the reproducible tier); `runs/` + `outputs/` require explicit `--scope` and pass through dry-run-preview + confirm. History stays append-only (matches 11). Retention is OPTIONAL — a pack declares it only if it wants auto-trim.

2. **Call surface (prototype confirmed):**
   - `workflow pack inspect <pack>` — read-only: sizes of `runs/ outputs/ intermediate/`, last-run status, disk usage.
   - `workflow pack clean <pack> --scope intermediate|outputs|runs|all [--keep N] [--before <ISO>] [--dry-run] [--yes]`
     - **Default scope (bare) = `intermediate`.**
     - `--scope runs|outputs|all` → **dry-run-preview is the DEFAULT; `--yes` required to execute** (the confirm gate). `--scope intermediate` → safe; dry-run optional (default off), no confirm needed.
   - Reuse `RunPersistence.delete` semantics for the actual removal (consistent with inline-script run deletion).

3. **Manifest retention contract (OPTIONAL):**
   ```jsonc
   "io": {
     "intermediate": { "retention": "all" | "last-N" | "purge-after-run" },  // default all
     "runs":         { "retention": "all" | "last-N" },                      // default all (append-only)
     "outputs":      { "retention": "all" | "last-N" }                       // default all
   }
   ```
   - **Vocabulary = `all` (default, append-only) + `last-N` (`--keep N`). Minimal — `successes-only` / `versioned-latest` deferred (YAGNI); add when a real pack needs them.**
   - When declared, the manifest's retention is the DEFAULT policy `clean` applies for that scope (still gated by dry-run/confirm for lossy tiers per #1). `--keep N` on the CLI overrides.

4. **Three-tier safety model (locked):**
   - `intermediate/` 🟢 **safe** — reproducible (re-derivable; cf. the determinism fog → 12). Bare-clean target.
   - `runs/` 🟡 **lossy** — the run record is gone; dry-run + confirm required.
   - `outputs/` 🟠 **maybe-wanted** — dry-run + confirm required; reproducible only if re-runnable.

**Deferrals:** `successes-only` / `versioned-latest` retention modes → future (YAGNI); the determinism/`purge-after-run` tension (does it break the resume invariant?) → 12; how `clean` finds **redirected** state for a checked-in pack → 07/13 (existing fog).
