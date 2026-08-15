# Spec — #1b Decay (per-entry heat → eviction reorder)

**Effort:** `2026-08-02-1b-decay`
**Origin:** UPSP §1 "per-entry decay + weight→form metabolism" (`.planning/2026-08-02-try-to-checkout-code-use-gh-and-learning-from-ht/findings.md` §1); backlog item `#1b`. Depends on #05 (PR #1012, `session_assembly`) + #06 (PR #1015, `used_at`) + #02 (`pin`).
**Branch:** `feat/hermes-decay` (off `origin/main`).

## Destination

Add a per-entry **heat** score that decays on disuse and is **consumed by the existing eviction victim-selection** — so stale, never-used, low-worth entries are evicted *first*, and used / high-worth / pinned entries are *spared*. This realizes UPSP §1's "decay-on-disuse" discipline adapted to hermes-memory's architecture (cheap tier, deterministic, no UPSP 3-zone daemon), and it closes the consumer side of #06's contract: *"used entries are spared, surfaced-but-never-used decay faster."*

## Background (current state, verified on `origin/main`)

- **Signals already in the DB**, but **not visible at the eviction site**:
  - `memories.created`, `memories.last_referenced` (recency) — in frontmatter, in-store.
  - `memories.mw_success`, `memories.mw_fail` (worth-scoring, recall success rate) — DB-only.
  - `session_assembly.used_at` (#06) — DB-only; `used_at IS NOT NULL` = the entry was content-matched in assistant text when surfaced.
  - `memories.pin` (#02) — protects from deletion; already respected in consolidation/eviction/supersession.
- **Eviction architecture** (a prior "D3" restructure collapsed it):
  - **Primary overflow path** = the LLM consolidator (`runConsolidator` → `consolidateTwoPhase` → `buildSnapshot` → MergePlan). Reached for every non-`reject` overflow with a consolidator wired.
  - **Deterministic floors** = `vaultOffloadAndAdd` (add overflow) + `vaultOffloadAndReplace` (replace overflow): FIFO victim scan (lowest file-position non-pinned), reached only when consolidation fails / budget is spent / no consolidator. Vaults victims to a `.knowledge.jsonl` archive (preservationist, never discards).
  - `purgeSupersededFromMarkdown` = **semantic** (a superseded entry is replaced, not stale) — out of heat's scope.
- **`MemoryStore` is deliberately DB-free** — all DB-dependent ops cross the boundary via a **callback/provider injection** pattern (superseded lookup, mdId-by-content, …). Heat must do the same; it cannot live as a store field.

## Design decisions (settled via grill — D1–D5)

### D1 — Scope = score + reorder eviction
Compute a per-entry heat; feed it into the **existing** overflow/eviction victim-selection (stale-unused first, used+pin spared last). **No new destructive trigger, no proactive consolidation, no LLM weight→form** (deferred). Pure instrumentation biasing an existing destructive path.

### D2 — Model = recency-exp spine + modulators
```
heat ∈ [0,1], higher = hotter = spared
recencySpine = exp(-ageDays / halflifeDays)        // age from lastReferenced (fallback created); the spine
worthMult    = 1 + worthWeight * (laplace - 0.5)    // laplace = (mw_success+1)/(mw_success+mw_fail+2); neutral 1.0
usedBonus    = usedExists ? usedBonusAmount : 0     // boolean ever-used (#06); small relative nudge
heat         = clamp(recencySpine * worthMult + usedBonus, 0, 1)
```
Halflife / worthWeight / usedBonus **config-tunable** (defaults: halflife 14d, worthWeight 0.15, usedBonus 0.1). Avoids UPSP's 3-zone `AH_high/AH_low` counter math (§1d — tuned for a 32-round daemon we don't run).

### D3 — Compute-on-demand
Heat is a **pure function evaluated at victim-selection time** from existing columns + an on-the-fly `used_at` aggregate. **No new column, no migration, no periodic job.** The score is always fresh (recency updates with wall-clock automatically). Persisted `heat` column + periodic decay job + UI exposure are all deferred.

### D4 — Used signal = boolean ever-used
`EXISTS(session_assembly row with mdId AND used_at IS NOT NULL)` → small binary heat bonus. Cheapest query (one batched `IN` per file's entries). Recency spine still drives staleness, so a used-once-long-ago entry decays via recency but slower than never-used — honoring #06's "spare-used / decay-unused-faster" as a **relative nudge, not an absolute lock** (pin remains the only absolute protection).

### D5 — Reorder = heat-ascending ordering key
At every **non-semantic** eviction site, pick **lowest-heat** first instead of FIFO/file-order; pin always spared (unchanged); supersession purge stays **semantic** (superseded goes regardless of heat). Deterministic.

## Architecture & integration (how it crosses the DB-free boundary)

1. **`computeHeat()` — pure scoring core** (`src/store/heat.ts`, new). Inputs: `{ lastReferenced?, created?, mwSuccess, mwFail, usedExists, now, config }` → `number ∈ [0,1]`. Date fallback: `lastReferenced ?? created ?? epoch(0 → heat 0)`. Unit-tested exhaustively (spine decay, worth nudge ±, used bonus, clamp, missing-dates).

2. **`getUsedMdIds(mdIds, {project})` — used-exists aggregate** on `SessionRepository` (SQLite + Surreal parity). Returns the subset of `mdIds` that have any `session_assembly` row with `used_at IS NOT NULL`. One batched query (`SELECT DISTINCT md_id … WHERE md_id IN (…) AND used_at IS NOT NULL`). Mirrors the #06 `markUsed` parity pattern.

3. **Heat-provider callback — the boundary bridge.** `MemoryStore` gains an optional injected provider (the established pattern):
   ```ts
   heatForEntries?: (target, mdIds: string[]) => Promise<Map<string, number>>
   ```
   Wired in `index.ts` where both repos live: it batches `mw_success/mw_fail` (memoryRepo) + `usedExists` (sessionRepo) for the entry set, then calls `computeHeat()` per entry. `null`/absent provider → heat disabled (fall back to current FIFO).

4. **Heat-ordered deterministic floors.** `vaultOffloadAndAdd` + `vaultOffloadAndReplace`: before the victim loop, fetch heats for the non-pinned candidates via the provider, then select the **lowest-heat** non-pinned victim each iteration (instead of lowest file-position). If the provider is absent or throws → current FIFO order (best-effort, never blocks eviction). Pin skip unchanged.

5. **Consolidator snapshot — heat-sorted (prompt-free bias).** `buildSnapshot` emits entries **sorted by heat ascending** (lowest-heat first). This is **baseHash-safe** (`snapshotBaseHash` is order-insensitive — verified in `merge-plan.ts`), so `applyMergePlan` reconciliation is unaffected. It gives the LLM a positional nudge toward dropping stale entries **without a prompt change** (the prompt-level heat hint is a tracked follow-up — risky/hard to test). When no provider, snapshot order is unchanged.

6. **Config knobs** (registered in `config.ts` `DEFAULT_CONFIG` + parse allowlist — the #06 config-gap lesson): `decayEnabled` (bool, default `true`), `decayHalflifeDays` (number, 14), `decayWorthWeight` (number, 0.15), `decayUsedBonus` (number, 0.1). `decayEnabled === false` → provider not wired → eviction reverts to current FIFO/file-order (behavioral parity; the disable path is a first-class invariant, not an afterthought).

## Timing

Heat is computed **lazily at eviction time** (overflow → floors/snapshot), never periodically, never persisted. No new lifecycle hook; it rides the existing overflow path.

## Acceptance criteria

1. **`computeHeat()` is pure + fully unit-tested**: recency spine `exp(-age/halflife)` monotonic decreasing; worth multiplier nudges above/below 1.0 around Laplace-0.5 neutral; used-bonus adds exactly `usedBonusAmount`; output clamped `[0,1]`; missing-dates fallback (last→created→epoch) behaves sanely. Config honored.
2. **`getUsedMdIds` parity**: SQLite + Surreal return identical subsets; batched `IN`; empty input → empty output (no-op); project accepted-but-ignored (`session_assembly` is a global, non-project-scoped ledger — D4's global boolean ever-used).
3. **Heat-provider wired** in `index.ts` from both repos; absent/throwing provider is a safe no-op (current FIFO).
4. **Floors heat-ordered**: `vaultOffloadAndAdd`/`vaultOffloadAndReplace` evict lowest-heat non-pinned first; pin always spared; used entries outrank unused at equal recency; a fully-pinned target still overflows to the limit guard. Verified with a deterministic integration test that constructs entries of known heat and asserts the eviction order.
5. **Disable path**: `decayEnabled === false` → eviction order is byte-identical to pre-#1b FIFO (regression-safe).
6. **No regressions**: full suite green; `worth-scoring` / `pin` / `consolidation` / `#06 used-detection` all untouched behaviorally; contract 3 pass; `tsc` exit 0.

## Out of scope (tracked follow-ups)

- **Consolidator prompt-level heat hint** (bias the LLM explicitly; needs prompt work + deterministic testing).
- **Persisted `heat` column + periodic decay job** (enables UI exposure / `ORDER BY heat` queries / aging logs).
- **Proactive consolidation** (decay marks candidates + triggers consolidation before overflow — UPSP "continuous metabolism").
- **Weight→form** (LLM promote hot short-notes → `[F]`; demote stale → `[A]` one-liner before delete — the heaviest §1 slice).
- **Used-rate / recency-weighted used** (richer than boolean ever-used; marginal gain).
- **Decay-zone UI / query surface** (expose heat to the user for debugging).

## Risks

- **Floor rarity:** the deterministic floors run only on consolidation failure, so the *primary* real-world heat effect lands with the deferred prompt-hint follow-up. The MVP delivers the **scoring foundation + deterministic guarantee + disable-safe parity**; the snapshot sort is a weak prompt-free bias. This is an explicit, accepted trade-off of D1's "no proactive consolidation" scope.
- **Behavioral change to eviction order:** FIFO → heat is observable; mitigated by `decayEnabled` off-switch + the disable-path parity test.
- **DB-free boundary:** the provider pattern is established, but a new provider adds surface; mitigated by making it optional + best-effort.
