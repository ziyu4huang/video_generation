> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: perment-solve-these-issues-architecturely

## Destination

**Trustworthy memory→vault convergence.** Every memory entry converges exactly
once into one canonical cross-linked knowledge card via a single deterministic
path, with a verifiable receipt — no invisible failures, no dual-namespace
duplicates, no silent writes to a disconnected vault, no noise that undermines
trust. The existing graph's legacy duplicates are collapsed, and convergence
completeness is enforced by a check, not remembered as scar-tissue.

## Notes

**Domain.** The pi memory subsystem: `pi-agent-ext-hermes-memory` (the memory
DB / `.md` write-source + the parallel `passive-converge` path) and
`pi-agent-ext-knowledge-card` (the canonical `zk_ingest` convergence + the vault
query index that `zk_ask` reads).

**Skills every session consults:** `grilling` + `domain-modeling` (decisions are
resolved one-at-a-time with a recommended answer); `grill-memory` (inform each
recommendation from past memory). Root `CONTEXT.md` already pins the memory
model's ubiquitous language (Kind × Scope → targets; `lesson` formerly
`failure`).

**Key architectural facts (verified against code this session — orient here
before any ticket):**
- The **canonical deterministic path already exists and is solid**:
  `zk_ingest` → `ingestRecords` (`bun-apps/pi-agent-ext-knowledge-card/src/ingest.ts`)
  → `runConvergenceLoop` (`src/loop.ts`). It is NO-LLM, idempotent, dedups by
  `record.id`, and already ships a `ConvergeReceipt`, a `healthGate`
  (`graphHealth`: dead-links / MOC missing-stale / orphans), a per-family
  `coverageReport` (missing = E−V), and an opt-in wiki-aware Jaccard ≥ 0.85
  cross-family upsert. Four source families: `workflow-jsonl`, `hermes`,
  `auto-memory`, `generic` — each mints a namespaced id (`<family>:<slug>`).
- The **dual-namespace / invisible-failure tax comes from a PARALLEL path** in
  `pi-agent-ext-hermes-memory` (`passive-converge` / `memory transfer`) that
  mints `pi-memory:<target>:<hash>` ids, bypasses `ingestRecords` (so no receipt,
  no health gate, no coverage), and whose state file misreports completion
  (43/52 = 83% unconverged in the live receipt). `coverageReport`'s own comment
  confirms: "`pi-memory:<hash>` and `hermes:<slug>` mint different ids — id-diff
  is only meaningful WITHIN a source family."
- **Vault role = derived query index** (`zk_ask` reads it); the hermes `.md`
  files are the write-source. Convergence is the DB→vault projection. (Direct
  vault writes via `generic`/obsidian are a known dual-write wrinkle — see
  *Not yet specified*.)
- **Reconcile from the primary worktree** (initialized vault submodule), never a
  dev worktree (submodule shows `-` in `git submodule status`).

**Standing prefs that bind this effort:** port from the single reference path,
not parallel comparison; verify against the built artifact, not source;
deterministic-by-design (atomic-zettel — no chunking, no LLM at ingest); speed
does not require compromise here (correctness-first).

## Decisions so far

<!-- the index — one line per closed ticket -->

- [01 — Research: the parallel convergence path's full surface](tickets/01-research-parallel-path-surface.md) — ADR-0001 already moved convergence to the knowledge-card hub; the dual-namespace survives as `hermes:<slug>` (canonical, deterministic) vs `pi-memory:<target>-<ts>-<rand>` (non-deterministic, from `writeTransferArchive`); the invisible-failure tax is the silent-fail `session_shutdown` auto-converge hook; "passive-converge" is gone; the 2026-07-11 memory entry is partly stale.
- [02 — Collapse strategy](tickets/02-collapse-strategy.md) — **Full unification**: single `hermes:<slug>` namespace for all lifecycles; hub auto-converge pulls live `.md` + the archive dir (ADR-0001-compliant); retire `pi-memory:*`; no manual ingest step. **Distill mechanism B vanishes** — enriched cards reuse the raw id (in-place upsert); `markSuperseded` becomes dead code.
- [03 — Completeness invariant + making failure loud](tickets/03-completeness-invariant.md) — **Unidirectional completeness** (`coverageReport.missing` = 0; sourceOrphaned reported not gated → rules vault dual-write out of scope). **Durable receipt** — shutdown hook writes `.pi/kcard-last-receipt.json` instead of swallowing the IngestSummary; never blocks shutdown; an on-demand surface reads it + runs coverageReport. Surface name itself is T07's call.
- [04 — Dev-worktree disconnected-vault footgun](tickets/04-dev-worktree-disconnected-vault.md) — **Refuse + detect (loud)** via `resolveVault` write-path strictness (the shared chokepoint): a Tier-3 auto-created `./vault` or uninitialized submodule is not written to; explicit callers error, the shutdown hook records the condition in the T03 receipt and skips. `OB_VAULT_PATH` stays as opt-in redirect.
- [05 — Migrate the pre-existing duplicate cards](tickets/05-migrate-legacy-duplicates.md) — **Merge via existing `mergeDuplicates`** (`zk-query --merge-duplicates [--fix]` — corrects a stale "unwritten" memory; it's built + tested, reversible: loser → `_archive/`). Dry-run at default **0.9**, review pairs (focus `pi-memory:*` ↔ `hermes:*`), apply; targeted 0.85 pass only if review shows missed true dupes. One-shot now + recurring guard via T07.
- [06 — SQLite disk-I/O noise strategy](tickets/06-sqlite-noise-strategy.md) — **Push `runWithTransientRetry` into the shared store** (`sqlite-memory-store.ts`) so every caller inherits retry. Premise partly stale: #633 already retried memory-tool + live-index; convergence is filesystem-only (never touches `sessions.db`). Surviving gap = 3 un-retried callers (grill-decision-tool, review-memory-ops, correction-detector). Exhaustion stays loud (15s patience = real).
- [07 — Enforcement surface](tickets/07-enforcement-surface.md) — **`/memory-health` command as the primary runtime surface** (reads the T03 receipt + runs a live `coverageReport`; the only place `missing=0` is meaningfully checkable — coverage is a runtime property, not PR-gateable). **CI deferred** (can't see live sources; lags submodule PRs). Threshold: `missing=0`; `sourceOrphaned` reported not gated; `_archive/` excluded (T05).

## Map status — COMPLETE

**All 7 tickets resolved** (T01 research; T02–T07 grilled + closed). The map is **decision-complete**; the **build** follows as implementation work — T02 unified `hermes:<slug>` path, T03 shutdown receipt, T04 `resolveVault` strictness, T05 `mergeDuplicates` migration, T06 shared-layer retry, T07 `/memory-health`. Each ticket's `## Resolution` section carries its build notes.

## Not yet specified

<!-- in-scope fog: suspected decisions that can't be ticketed sharply yet -->

- **Does `zk_ask` need any change once the vault is clean?** Probably not (it
  reads the vault as-is), but a duplicate-free graph may change retrieval
  rankings. Verify after T05 (legacy-dupe migration) — not specifiable until the
  migration approach is chosen.

## Out of scope

- **The cross-cutting guardrail layer for OTHER subsystems** (CI/deploy-parity,
  token/prompt-cost governance) — the rejected broad destination; a separate
  effort if pursued.
- **Redesigning the vault's role** (canonical vs derived). The vault stays a
  derived query index; this map fixes the *projection into it*, not the vault
  model itself.
- **The memory WRITE model** (how entries get INTO the hermes `.md` DB). This
  map is strictly the DB→vault convergence projection.
- **The vault dual-write model** (`generic`/obsidian direct writes). Ruled out
  by T03's unidirectional invariant — direct-write cards don't violate 'every
  source entry → a card'; they surface as `sourceOrphaned` (reported, not
  gated). Vault-write hygiene is a separate subsystem if ever pursued.
