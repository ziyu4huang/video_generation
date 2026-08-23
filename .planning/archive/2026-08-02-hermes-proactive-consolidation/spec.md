# Spec — hermes-memory proactive consolidation (UPSP §1 "continuous metabolism")

- **Date:** 2026-08-03
- **Status:** design (pending plan)
- **Scope:** single spec → single plan → single implementation cycle
- **Source:** the slice #1b (decay) explicitly deferred — `.planning/2026-08-02-1b-decay/spec.md` "Deferred follow-ups → Proactive consolidation". Grill: `.planning/2026-08-02-hermes-proactive-consolidation/map.md` (D1–D5).

## 1. Problem

#1b gave every memory entry a per-entry **heat** (recency-decay spine + worth/used
modulators) and reordered the **existing** overflow/eviction victim-selection by heat
(stale-unused evicted first). But it was deliberately **scope-capped at "no new destructive
trigger, no proactive consolidation"** — consolidation still fires only when the store
**overflows** capacity. The result: a store full of decayed low-heat entries sits untouched
until it overflows, at which point a large reactive consolidation runs. UPSP §1 calls the
missing half "continuous metabolism" — the store should **proactively** metabolize decayed
material *before* overflow, keeping the live set lean and the injected prompt fresh.

This spec closes that gap: decay (heat) now also **triggers** consolidation, not just biases
its victim-selection.

## 2. Design decisions (resolved via wayfinder grill — see map.md D1–D5)

- **D1 — Trigger model = decay-pressure on writes.** On each memory write (add/sync), if the
  count of below-heat-floor entries ("decay-pressure") exceeds a threshold, trigger a
  consolidation pass over the low-heat tail. **No daemon / no periodic job** — it metabolizes
  on activity, reusing the existing injected 2-phase consolidator. Replaces #1b's "no
  proactive consolidation" cap.
- **D2 — Candidate set = heat-floor prefilter + K cap.** Feed the consolidator only entries
  below a configurable heat-floor, **capped at K** (the bottom-K of the below-floor set). Only
  truly-decayed entries are candidates; the prompt is bounded; the LLM still decides what to
  actually merge (it may merge nothing if nothing's related). Knobs: `heatFloor` + `maxCandidates (K)`.
- **D3 — Rate limiting = cooldown + in-flight guard.** A min interval (`cooldownMinutes`)
  between proactive passes **and** skip the trigger if a consolidation is already running.
  Bounds frequency and prevents two overlapping 2-phase reconcile-writes from racing.
- **D4 — Placement = `MemoryStore.maybeProactiveConsolidate()` + handler fires-after-write.**
  The store owns the pressure-check + cooldown + in-flight gate (instance state — **DB-free**,
  using only the injected heat provider + consolidator). The write handler calls it
  **fire-and-forget** after each add/sync. No write-path blocking; no recursion (handler-controlled
  call site, not inside `_add`); respects the DB-free boundary.
- **D5 — Config surface = full knob set, opt-in (`enabled=false` default).** Knobs:
  `proactiveConsolidateEnabled`, `proactiveHeatFloor`, `proactiveMaxCandidates`,
  `proactivePressureThreshold`, `proactiveCooldownMinutes`. **All registered in `config.ts`
  `DEFAULT_CONFIG` + the parse allowlist from the start** (the #06 config-gap lesson). Ships
  off by default — proactive LLM consolidation is invasive (destructive merges on activity),
  so it's a feature-flag rollout until validated.

## 3. Architecture (grounded in the current seams)

The proactive path **reuses the existing consolidation pipeline** — it adds a *trigger* + a
*candidate limit* + *rate-limiting*, not a new mechanism:

- `MemoryStore.consolidateTwoPhase(target, signal, onProgress)` (private, `memory-store.ts:455`)
  builds a snapshot from in-memory entries (pinned excluded, heat-sorted lowest-first per #1b),
  calls the injected consolidator (lock-free `MergePlan`), then does a brief locked
  reconcile-write. Today it consolidates **all** consolidatable entries.
- `MemoryStore.runConsolidator(target, …)` (private wrapper, `:514`) wraps the above with the
  `PI_HERMES_CONSOLIDATING=1` child-guard env + always-logged perf record. This is the
  "auto-consolidation" entry.
- `auto-consolidate.ts → triggerConsolidation(…)` (`:78`) is the public handler that fires on
  overflow today.
- **`commit-guards.ts → isConsolidationInFlight()` / `consolidationInFlight` state** — an
  **existing** in-flight guard. **D3 reuses it**: `maybeProactiveConsolidate` checks
  `isConsolidationInFlight()` (and the store-internal cooldown) rather than inventing a new
  concurrency flag.
- `commit-project-memory.ts` is the project-memory write path that already consults
  `isConsolidationInFlight()` — the natural **fires-after-write** hook point (D4).

### New seams

1. **`maybeProactiveConsolidate(target)` on `MemoryStore`** (new public method):
   - guard: `proactiveConsolidateEnabled === false` → no-op; `isConsolidationInFlight()` → no-op;
     `now - lastProactiveRun < cooldownMinutes` → no-op.
   - compute heats via the existing `computeHeats`/`heatOf` (#1b); count entries below
     `proactiveHeatFloor` = decay-pressure.
   - if `decay-pressure >= proactivePressureThreshold`: select the bottom-`proactiveMaxCandidates`
     below-floor entries as the candidate set, then delegate to a consolidation entry that
     accepts a **candidate filter** (see seam 2).
   - all DB-free: uses only the injected heat provider + consolidator + instance state
     (`lastProactiveRun` timestamp; the in-flight check delegates to `commit-guards`).

2. **Candidate-limit seam on the consolidation entry** (backward-compatible): `consolidateTwoPhase`
   / `runConsolidator` gain an optional `candidates?: string[]` (a pre-filtered, pin-excluded,
   heat-limited entry set). When provided, the snapshot is built from `candidates` instead of
   `entriesFor(target)`. When **absent**, behavior is byte-identical to today's overflow path
   (the existing tests prove this — disable-path parity, as in #1b). `maybeProactiveConsolidate`
   passes the below-floor∩K set; the overflow path passes nothing.

3. **Fires-after-write hook** (D4): after a successful add/sync in the write handler
   (`commit-project-memory.ts` and/or the `addMemory`-adjacent path), call
   `store.maybeProactiveConsolidate(target)` **fire-and-forget** (not awaited on the write's
   critical path). Guarded by `proactiveConsolidateEnabled`.

4. **Config** (`config.ts`): add the 5 knobs to `DEFAULT_CONFIG` (with the D5 defaults) **and**
   to the explicit per-field parse allowlist (the `typeof`/`isNonNegativeNumber` block at
   `config.ts:~261`, next to the #1b `decay*` knobs).

## 4. Scope

**IN:** the `maybeProactiveConsolidate` trigger + cooldown + in-flight reuse; the
`candidates` candidate-limit seam on the consolidation entry; the fires-after-write hook; the
5 config knobs (registered fully); tests for trigger pressure, candidate-limit, cooldown,
in-flight skip, disable-path parity, and config.

**OUT (explicitly deferred — tracked follow-ups):**
- **Periodic background job / daemon** (D1 chose on-writes; a safety tick is a later option).
- **Weight→form** (LLM promote/demote — the heaviest §1 slice).
- **Persisted `heat` column / UI exposure** (heat stays compute-on-demand per #1b D3).
- **Pressure as a fraction** (D5 uses a count threshold; fraction-of-capacity is a later tuning).
- **No schema migration** (heat is computed, not stored — per #1b D3; proactive adds no column).

## 5. Acceptance criteria

1. With `proactiveConsolidateEnabled=false` (default), **zero** behavioral change: no proactive
   pass ever fires; existing overflow consolidation is byte-identical (disable-path parity test).
2. With it enabled, after a write that leaves `decay-pressure >= threshold`, a proactive
   consolidation pass runs **at most once per `cooldownMinutes`** and **never while another
   consolidation is in-flight**.
3. The consolidator receives a candidate set limited to below-`heatFloor` entries, capped at
   `maxCandidates` (asserted: the snapshot fed to the consolidator contains no above-floor
   entry and no more than K entries).
4. A proactive pass that finds nothing merge-worthy is a safe no-op (the LLM merges nothing →
   `consolidated: false`, no data loss).
5. The write path is **not blocked** by proactive consolidation (fire-and-forget; the write
   returns before the consolidation completes).
6. All 5 knobs are settable via the config file (parse-allowlisted) and have the D5 defaults;
   a config test asserts each parses + falls back to default on invalid input.
7. Full suite stays green; the new behavior is feature-flagged off by default so the baseline
   (post-#1b, ~1223 pass) is unaffected until opted in.

## 6. Risks + mitigations

- **Write-path latency / recursion** — mitigated by fire-and-forget (D4) + cooldown (D3) +
  the `PI_HERMES_CONSOLIDATING=1` child-guard (a consolidator child never spawns its own).
- **Over-consolidation / data loss** — mitigated by candidate-limit (only below-floor, capped K;
  D2), the LLM's own merge judgment, pin-exclusion (unchanged), and the destructive-merge
  invariant (offload-superseded-first; `REJECTED.md`). A no-merge pass is a safe no-op (A4).
- **Race with overflow consolidation** — mitigated by reusing `isConsolidationInFlight()` (D3);
  two concurrent consolidations can't start.
- **DB-free boundary** — `maybeProactiveConsolidate` uses only injected heat + consolidator +
  instance state; no repo import (mirrors #1b's provider pattern).
- **Config gap** — all 5 knobs registered in `DEFAULT_CONFIG` + parse allowlist from Task 1
  (the #06 lesson; A6).

## 7. Rollout

- `proactiveConsolidateEnabled=false` default → opt-in feature flag. No migration, no backfill
  (heat is compute-on-demand). Enable per-deployment via config file once validated.
