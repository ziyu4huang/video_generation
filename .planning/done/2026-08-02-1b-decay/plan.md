# Plan — #1b Decay (SDD, 6 TDD tasks)

**Spec:** `./spec.md` · **Branch:** `feat/hermes-decay` (off `origin/main`) · **Baseline:** hermes-memory ext full suite (run `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )` on the fresh branch, record the count).

**Task graph:** T1 → T2 → T3 → T4 → T5 → T6. Each task: implementer (medium tier) + L2 watchdog + reviewer (big tier on T4/T6). One commit per task.

---

## Task 1 — `computeHeat()` pure core + config surface (complete, no gap)

**Goal:** the scoring foundation + the full config surface (fields + defaults + config.ts registration — the #06 config-gap lesson baked in from the start).

**Files:**
- `src/types.ts` — add `MemoryConfig` fields: `decayEnabled?: boolean`, `decayHalflifeDays?: number`, `decayWorthWeight?: number`, `decayUsedBonus?: number`.
- `src/constants.ts` — add `DEFAULT_DECAY_HALFLIFE_DAYS = 14`, `DEFAULT_DECAY_WORTH_WEIGHT = 0.15`, `DEFAULT_DECAY_USED_BONUS = 0.1`. Add `MS_PER_DAY`.
- `src/config.ts` — register all four in `DEFAULT_CONFIG` + the parse allowlist (`decayEnabled` boolean guard; the three numbers via `isNonNegativeNumber` — except `decayWorthWeight`/`decayUsedBonus` which may be 0..1; use `isFinite && >= 0`). Mirror the `worthScoring`/`usedDetection` siblings.
- `src/store/heat.ts` (NEW) — pure `computeHeat(input, config)`:
  ```
  input: { lastReferenced?: string; created?: string; mwSuccess: number; mwFail: number; usedExists: boolean; now: Date }
  config: { halflifeDays, worthWeight, usedBonus }
  → number ∈ [0,1]
  ageDays = (now - parseDate(lastReferenced ?? created ?? "1970-01-01")) / MS_PER_DAY  (≥ 0)
  recencySpine = exp(-ageDays / halflifeDays)
  laplace = (mwSuccess + 1) / (mwSuccess + mwFail + 2)
  worthMult = 1 + worthWeight * (laplace - 0.5)
  heat = clamp(recencySpine * worthMult + (usedExists ? usedBonus : 0), 0, 1)
  ```
  Export a small `resolveDecayConfig(config)` helper that reads `config.decay* ?? DEFAULT_*` (shared by T3). Pure, no I/O.

**TDD (`tests/store/heat.test.ts`):** spine monotonic decreasing as age grows; `exp(-halflife/halflife)≈0.368` at exactly one halflife; worthMult > 1 when laplace > 0.5, < 1 when < 0.5, == 1 at 0.5; usedBonus adds exactly the configured amount; clamp at 0 (huge age) and cap behavior; missing-dates fallback (last→created→epoch=0); config knobs honored (halflife/worthWeight/usedBonus); `resolveDecayConfig` defaults. Pure property-style cases.

**Verify:** `bun test tests/store/heat.test.ts` green; `bun run check` exit 0.
**Commit:** `feat(hermes): computeHeat scoring core + decay config (UPSP §1)`

---

## Task 2 — `getUsedMdIds` (used-exists aggregate, SQLite + Surreal parity)

**Goal:** the #06 `used_at` signal as a per-entry boolean aggregate, batched.

**Files:**
- `src/store/repository.ts` — add `getUsedMdIds(mdIds: string[], opts: { project: string | null }): Promise<Set<string>>` to `SessionRepository` (returns the subset of `mdIds` with ≥1 `session_assembly` row `used_at IS NOT NULL`).
- `src/store/sqlite/sqlite-session-repo.ts` — impl: `SELECT DISTINCT md_id FROM session_assembly WHERE md_id IN (...) AND used_at IS NOT NULL`. Use the existing placeholder-chunking helper if one exists (mirror `markUsed`'s `IN $ids` handling); empty input → empty Set (no-op, no SQL).
- `src/store/surreal/surreal-session-repo.ts` — parity: `SELECT DISTINCT md_id FROM session_assembly WHERE md_id IN $ids AND used_at IS NOT NULL` (Surreal array bind); empty → empty Set.

**TDD:** contract test per backend — seed N session_assembly rows (some used_at set, some null, some mdId absent), assert the returned Set is exactly the used subset; empty input → empty; all-unused → empty; project scoping respected (if session_assembly is project-scoped — check the schema; if not, project arg is ignored, note it). Mirror the #06 `markUsed` test style (those tests already exercise session_assembly).

**Verify:** `bun test` green; `bun run check` exit 0.
**Commit:** `feat(hermes): getUsedMdIds used-exists aggregate (SQLite+Surreal, UPSP §1)`

---

## Task 3 — heat-provider callback + index.ts wiring

**Goal:** bridge the DB-free `MemoryStore` boundary with the established provider-injection pattern.

**Files:**
- `src/store/memory-store.ts` — add an optional injected field (constructor or a `setHeatProvider()` setter mirroring how other providers are attached — read the file to match the existing injection idiom):
  ```ts
  heatForEntries?: (target: "memory"|"user"|"failure", mdIds: string[]) => Promise<Map<string /*mdId*/, number /*heat*/>>
  ```
  Keep the store DB-free (no repo import). Store a reference; no behavior change yet (T4/T5 consume it).
- `src/index.ts` — wire the provider where both repos live (near the other provider injections ~L466): build a function that, given `(target, mdIds)`, (a) fetches `mw_success/mw_fail` per mdId from `memoryRepo` (batched — check for an existing `getMemories`/batch method; if none, a bounded loop), (b) calls `sessionRepo.getUsedMdIds(mdIds, {project})`, (c) maps each entry's `lastReferenced`/`created` (needs the .md entry dates — fetch from store or accept the caller passes them; decide the cleanest seam), (d) returns `Map<mdId, computeHeat(...)`. Guard: if `config.decayEnabled === false` → do NOT set the provider (store sees `undefined` → T4/T5 fall back to FIFO). Best-effort try/catch → on any failure return an empty Map (store treats missing heat as neutral → falls back gracefully).
  - **Seam decision (resolve in task):** the provider needs per-entry `lastReferenced`/`created`. Cleanest: the store passes the **decoded entry dates** alongside mdIds (extend the provider signature to `(target, entries: {mdId, lastReferenced?, created?}[])`), so the provider doesn't re-read the store. The store already decodes entries for eviction/snapshot. Pick whichever matches the existing provider signatures best.

**TDD:** unit test the provider builder in isolation (stub memoryRepo + sessionRepo → assert the heat Map per entry: a used+recent+high-worth entry > an unused+stale+low-worth entry); `decayEnabled===false` → provider not attached; throw in a repo → empty Map (no throw). The store-level wiring is exercised in T4/T6.

**Verify:** `bun test` green; `bun run check` exit 0.
**Commit:** `feat(hermes): heat-provider callback + index.ts wiring (UPSP §1)`

---

## Task 4 — heat-ordered deterministic eviction floors

**Goal:** `vaultOffloadAndAdd` + `vaultOffloadAndReplace` evict lowest-heat non-pinned first.

**Files:**
- `src/store/memory-store.ts`:
  - `vaultOffloadAndAdd`: before the victim `while` loop, if `this.heatForEntries` is set, fetch heats for the current `remaining` non-pinned candidates' mdIds → `Map`. Change victim selection: instead of `victimIdx = 0; while (isPinned) victimIdx++`, pick the index of the **lowest-heat** non-pinned entry (ties broken by file order for determinism). Re-fetch/refresh the heat view as the set shrinks, OR compute once and skip evicted mdIds (cheaper — compute once, skip evicted mdIds in the lookup). Provider absent OR empty Map → current FIFO (file-order) — exact parity.
  - `vaultOffloadAndReplace`: same — the `evictOrder` (currently lowest file-position non-pinned excluding protected) becomes lowest-heat non-pinned excluding protected, when heats available.
  - Pin skip unchanged (pin always spared). A fully-pinned target still overflows to the limit guard (unchanged).

**TDD:** extend the existing `vaultOffload*` tests (find them) + add: construct entries of known heat (via a stub heatForEntries returning a fixed Map), assert the evicted set is lowest-heat-first; a used entry outranks an unused one at equal age; pin is never evicted even at heat 0; provider absent → FIFO order (regression); provider returns empty Map → FIFO. Best-effort: provider throws → FIFO (no crash).

**Verify:** `bun test` green; `bun run check` exit 0.
**Commit:** `feat(hermes): heat-ordered eviction floors (UPSP §1)`

---

## Task 5 — consolidator snapshot heat-sort (baseHash-safe, prompt-free)

**Goal:** `buildSnapshot` emits entries sorted by heat ascending (lowest-heat first) — a positional nudge, no prompt change.

**Files:**
- `src/store/merge-plan.ts`:
  - `parseEntry` — also return `mdId` (derive from frontmatter/comment; the store's `mdIdOf` logic — reuse or mirror). Add `mdId?: string` to `SnapshotEntry`.
  - `buildSnapshot(target, encodedEntries, charLimit, heats?: Map<string,number>)` — when `heats` is provided (non-empty), `entries.sort` by `(heats.get(mdId) ?? NEUTRAL_HEAT)` ascending, stable (ties keep parse order). When `heats` absent/undefined → **do not sort** (preserve current order — exact parity, critical for the disable path). `snapshotBaseHash` is order-insensitive (already verified) → reconciliation unaffected.
  - **`NEUTRAL_HEAT`** (e.g. 0.5) is only used when `heats` is provided but an entry's mdId is missing — place neutrally.
- `src/store/memory-store.ts` `consolidateTwoPhase`: when `this.heatForEntries` is set + `config.decayEnabled !== false`, fetch heats for the `consolidatable` entries' mdIds, pass to `buildSnapshot`. Absent → pass nothing (current behavior).

**TDD:** `buildSnapshot` with heats → entries ordered lowest-heat-first; absent heats → order unchanged (byte-identical to pre-change); tie → stable; `snapshotBaseHash` identical regardless of sort (assert!); missing-mdId entry → neutral. `consolidateTwoPhase` passes heats when enabled, omits when disabled.

**Verify:** `bun test` green; `bun run check` exit 0.
**Commit:** `feat(hermes): baseHash-safe heat-sort of consolidator snapshot (UPSP §1)`

---

## Task 6 — integration test + full matrix + final review + PR + merge

**Goal:** end-to-end deterministic proof + ship.

**Integration test (`tests/integration/decay-eviction.test.ts`):**
- Construct a memory target with entries of known, controlled heat (mock/stub the heat-provider to return a fixed Map; OR seed real mw_*/used + dates and let real `computeHeat` run — prefer the latter for fidelity, the former for determinism; do BOTH: a real-pipeline test + a stub-heat deterministic test).
- Force overflow (entries exceeding `memoryCharLimit`) with NO consolidator wired (so the `vaultOffloadAndAdd` floor runs deterministically) → assert evicted set == lowest-heat non-pinned entries, used+recent survive, pin survives, order is heat-ascending.
- `decayEnabled === false` → eviction order byte-identical to pre-#1b (capture the expected FIFO order as a fixture).
- Real pipeline: seed mw_success/fail + used_at (via the repos) + dates → overflow → assert a high-worth-used entry survives a low-worth-unused entry of equal recency.

**Final whole-branch review (big tier):** spec coverage D1–D5 + Acceptance 1–6; the DB-free boundary respected; disable-path parity; no consolidation/snapshot regression (baseHash invariant); backend parity; park any findings.

**Verify (controller):** `bun test` (full suite, 0 fail), `bun test tests/extension-contract.test.ts` (3 pass), `bun run check` (exit 0).

**Ship:** commit durable docs (`spec.md` + `plan.md`); push; `gh pr create`; `await_pr_merge(prNumber, strategy="rebase")`; rest worktree on `work/hermes-memory`.

---

## Notes for implementers

- **DB-free boundary is sacred** — never import a repo into `memory-store.ts`/`merge-plan.ts`. Cross via the provider callback only.
- **Disable path = first-class invariant** — `decayEnabled === false` MUST reproduce pre-#1b FIFO exactly (test it). The provider is simply not attached.
- **Best-effort everywhere** — provider absent/throwing/empty → current behavior. Heat never blocks eviction.
- **Determinism** — heat ties broken by file order; tests use fixed `now` + known mw/used to get reproducible heat.
- **baseHash** — the snapshot sort MUST NOT change `snapshotBaseHash` (order-insensitive by construction; assert it).
