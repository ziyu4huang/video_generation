# hermes-memory proactive consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make decay (heat) **trigger** consolidation before overflow — on each memory write, if enough entries have decayed below a heat-floor, fire a bounded, rate-limited consolidation pass over the low-heat tail (UPSP §1 "continuous metabolism", the slice #1b deferred).

**Architecture:** A new `MemoryStore.maybeProactiveConsolidate()` owns the pressure-check + cooldown + candidate-selection (DB-free, reusing #1b's injected heat + the injected consolidator). A backward-compatible `candidates?` seam on `consolidateTwoPhase`/`runConsolidator` limits the snapshot to the low-heat tail. A reusable guard helper in `auto-consolidate.ts` is wired fire-and-forget at the memory-write site. All off by default (feature-flag).

**Tech Stack:** TypeScript (Bun), `bun test`. No new deps. No schema migration (heat is compute-on-demand per #1b).

**Spec:** `.planning/2026-08-02-hermes-proactive-consolidation/spec.md`
**Grill:** `.planning/2026-08-02-hermes-proactive-consolidation/map.md` (D1–D5)

## Global Constraints

- **DB-free boundary:** `MemoryStore`/the trigger method must NOT import the repository (DB layer). Heat crosses via the injected `heatForEntriesProvider`; consolidation via the injected `consolidator` (mirrors #1b's provider pattern). The in-flight check reuses the existing `isConsolidationInFlight()` at the **handler/hook** (not inside the store method) — so the store stays DB-free.
- **Config-surface lesson (#06):** ALL 5 knobs registered in `config.ts` `DEFAULT_CONFIG` **and** the per-field parse allowlist from **Task 1** (the explicit `typeof`/`isNonNegativeNumber` block next to the #1b `decay*` knobs). No cross-cutting gap.
- **Backward compatibility:** the `candidates?` seam (Task 2) is **absent on the overflow path** → byte-identical to today (existing tests prove disable-path parity).
- **Disable-path parity:** `proactiveConsolidateEnabled === false` (default) → no proactive pass ever fires; baseline suite (~1223 pass post-#1b) unaffected until opted in.
- **No blocking:** the write hook is **fire-and-forget** (`void … .catch(() => {})`) — the write returns before the consolidation completes. Cooldown + `PI_HERMES_CONSOLIDATING` child-guard prevent recursion.
- **Platform/tests:** Apple Silicon. Tests: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test )`. Shell discipline: never top-level `cd`; use `( cd <dir> && ... )`. No `package-lock.json`.
- **Defaults:** `proactiveConsolidateEnabled=false`, `proactiveHeatFloor=0.25`, `proactiveMaxCandidates=20`, `proactivePressureThreshold=10`, `proactiveCooldownMinutes=30`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types.ts` | shared types | add 5 `proactive*` fields to `MemoryConfig` |
| `src/constants.ts` | defaults | add 5 `DEFAULT_PROACTIVE_*` constants |
| `src/config.ts` | config load | add 5 knobs to `DEFAULT_CONFIG` + parse allowlist |
| `src/store/memory-store.ts` | store | Task 2: `candidates?` seam on `consolidateTwoPhase`/`runConsolidator`; Task 3: `maybeProactiveConsolidate` + `lastProactiveRun` state |
| `src/handlers/auto-consolidate.ts` | consolidation handler | Task 4: `fireProactiveIfReady` guard helper |
| `src/tools/memory-tool.ts` (or the add/edit write site) | tool surface | Task 4: wire `fireProactiveIfReady` fire-and-forget after a successful add/edit |
| `tests/config.test.ts` | config tests | Task 1: parse/defaults/invalid-fallback for the 5 knobs |
| `tests/store/memory-store.test.ts` | store tests | Task 2: candidate-seam; Task 3: trigger/cooldown/pressure/candidates |
| `tests/handlers/auto-consolidate.test.ts` (or nearest) | handler tests | Task 4: guard helper (enabled/in-flight/fire-and-forget) |
| `tests/integration/proactive-consolidation.test.ts` (new) | integration | Task 5: end-to-end + parity + non-blocking |

---

## Task 1: Config — 5 proactive-consolidation knobs

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/types.ts` (add fields to `MemoryConfig`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/constants.ts` (add `DEFAULT_PROACTIVE_*`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/config.ts` (`DEFAULT_CONFIG` + parse allowlist)
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/config.test.ts`

**Interfaces:**
- Produces: `proactiveConsolidateEnabled: boolean`, `proactiveHeatFloor: number`, `proactiveMaxCandidates: number`, `proactivePressureThreshold: number`, `proactiveCooldownMinutes: number` on `MemoryConfig`; the 5 `DEFAULT_PROACTIVE_*` constants; full parse-allowlist coverage.

- [ ] **Step 1: Write failing tests** (append to `tests/config.test.ts`)

```ts
import { loadConfig } from "../../src/config.js";
import { DEFAULT_CONFIG } from "../../src/config.js"; // adjust if DEFAULT_CONFIG is not exported; else read via loadConfig() with no file

test("DEFAULT_CONFIG has the 5 proactive knobs with the spec defaults", () => {
  const c = loadConfig("/nonexistent-path-so-defaults-apply", "/tmp");
  expect(c.proactiveConsolidateEnabled).toBe(false);
  expect(c.proactiveHeatFloor).toBe(0.25);
  expect(c.proactiveMaxCandidates).toBe(20);
  expect(c.proactivePressureThreshold).toBe(10);
  expect(c.proactiveCooldownMinutes).toBe(30);
});

test("proactive knobs parse from a config object (allowlisted)", () => {
  // Use the existing test helper that parses a raw config object, or loadConfig
  // against a temp file — mirror the existing decay-knob parse test in this file.
  const c = parseRawConfig({ proactiveConsolidateEnabled: true, proactiveHeatFloor: 0.5, proactiveMaxCandidates: 5, proactivePressureThreshold: 3, proactiveCooldownMinutes: 10 });
  expect(c.proactiveConsolidateEnabled).toBe(true);
  expect(c.proactiveHeatFloor).toBe(0.5);
  expect(c.proactiveMaxCandidates).toBe(5);
  expect(c.proactivePressureThreshold).toBe(3);
  expect(c.proactiveCooldownMinutes).toBe(10);
});

test("invalid proactive knobs fall back to defaults (parse allowlist guards)", () => {
  const c = parseRawConfig({ proactiveConsolidateEnabled: "yes", proactiveHeatFloor: "high", proactiveMaxCandidates: -1, proactivePressureThreshold: "x", proactiveCooldownMinutes: null });
  expect(c.proactiveConsolidateEnabled).toBe(false);       // non-boolean → default
  expect(c.proactiveHeatFloor).toBe(0.25);                 // non-finite-number → default
  expect(c.proactiveMaxCandidates).toBe(20);                // non-positive-int → default
  expect(c.proactivePressureThreshold).toBe(10);            // non-finite-number → default
  expect(c.proactiveCooldownMinutes).toBe(30);              // non-number → default
});
```

> Adapt to the file's REAL helpers: if it has a `parseRawConfig`/`loadConfig`-against-temp-file fixture already (the `decay*` tests use one), reuse it verbatim. If `DEFAULT_CONFIG` is exported, assert directly. The three tests above are the contract: defaults present, parse works, invalid → default.

- [ ] **Step 2: Run → FAIL** (`config.proactiveConsolidateEnabled` undefined)
  Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/config.test.ts )`

- [ ] **Step 3: Implement**

In `src/constants.ts` (next to the `DEFAULT_DECAY_*` constants from #1b):
```ts
export const DEFAULT_PROACTIVE_ENABLED = false;
export const DEFAULT_PROACTIVE_HEAT_FLOOR = 0.25;
export const DEFAULT_PROACTIVE_MAX_CANDIDATES = 20;
export const DEFAULT_PROACTIVE_PRESSURE_THRESHOLD = 10;
export const DEFAULT_PROACTIVE_COOLDOWN_MINUTES = 30;
```

In `src/types.ts`, add to `MemoryConfig` (next to the `decay*` fields):
```ts
  /** UPSP §1 proactive consolidation — fire a bounded pass over the decayed tail before overflow. Off by default. */
  proactiveConsolidateEnabled: boolean;
  proactiveHeatFloor: number;        // heat < floor ⇒ decay-pressure candidate
  proactiveMaxCandidates: number;    // K cap on the candidate set
  proactivePressureThreshold: number; // min below-floor count to trigger
  proactiveCooldownMinutes: number;   // min interval between proactive passes
```

In `src/config.ts` `DEFAULT_CONFIG` (after the `decay*` block, ~line 78):
```ts
  proactiveConsolidateEnabled: DEFAULT_PROACTIVE_ENABLED,
  proactiveHeatFloor: DEFAULT_PROACTIVE_HEAT_FLOOR,
  proactiveMaxCandidates: DEFAULT_PROACTIVE_MAX_CANDIDATES,
  proactivePressureThreshold: DEFAULT_PROACTIVE_PRESSURE_THRESHOLD,
  proactiveCooldownMinutes: DEFAULT_PROACTIVE_COOLDOWN_MINUTES,
```
In the parse allowlist (the `typeof`/`isNonNegativeNumber` block at ~line 261, after the `decay*` checks):
```ts
      if (typeof parsed.proactiveConsolidateEnabled === "boolean") config.proactiveConsolidateEnabled = parsed.proactiveConsolidateEnabled;
      if (typeof parsed.proactiveHeatFloor === "number" && Number.isFinite(parsed.proactiveHeatFloor) && parsed.proactiveHeatFloor >= 0 && parsed.proactiveHeatFloor <= 1) config.proactiveHeatFloor = parsed.proactiveHeatFloor;
      if (Number.isInteger(parsed.proactiveMaxCandidates) && (parsed.proactiveMaxCandidates as number) > 0) config.proactiveMaxCandidates = parsed.proactiveMaxCandidates;
      if (typeof parsed.proactivePressureThreshold === "number" && Number.isFinite(parsed.proactivePressureThreshold) && parsed.proactivePressureThreshold >= 0) config.proactivePressureThreshold = parsed.proactivePressureThreshold;
      if (isNonNegativeNumber(parsed.proactiveCooldownMinutes)) config.proactiveCooldownMinutes = parsed.proactiveCooldownMinutes;
```
> Confirm the exact name of the `isNonNegativeNumber` helper already used in this file (the `decay*` block uses it) and reuse it. Mirror the existing `decay*` parse lines for style.

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(hermes-memory): config surface for proactive consolidation (5 knobs, opt-in)`

---

## Task 2: Candidate-limit seam on `consolidateTwoPhase`/`runConsolidator`

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts` (`consolidateTwoPhase` ~455, `runConsolidator` ~514)
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-store.test.ts`

**Interfaces:**
- Produces: an optional `candidates?: string[]` parameter on `consolidateTwoPhase(target, signal, onProgress, candidates?)` and `runConsolidator(target, signal, onProgress, candidates?)`. When `candidates` is provided, the consolidator snapshot is built from `candidates` (already pin-excluded + heat-limited by the caller) instead of `entriesFor(target)`. When **absent**, behavior is byte-identical to today.

- [ ] **Step 1: Write failing test** (append to `tests/store/memory-store.test.ts`)

```ts
test("consolidateTwoPhase with a candidates filter limits the snapshot to those entries", async () => {
  // store seeded with entries A,B,C,D (all consolidatable, none pinned); a heat
  // provider wired so heats are deterministic.
  const store = makeStoreWithEntries([entry("A ..."), entry("B ..."), entry("C ..."), entry("D ...")]);
  // Spy on the injected consolidator to capture the snapshot it receives.
  let seen: string[] = [];
  store.setConsolidator(async (snapshot) => {
    seen = snapshot.entries.map((e: any) => e.text ?? e.content);
    return { plan: { ops: [] } };           // merge nothing → safe no-op
  }, "test");
  // Call the internal path via a thin test seam OR a public wrapper that threads
  // candidates. (See Step 3 — expose candidates on the public entry used here.)
  await store.runConsolidatorForTest("memory", undefined, undefined, ["C ...", "D ..."]);
  expect(seen.sort()).toEqual(["C ...", "D ..."].sort());   // only the candidates
  expect(seen).not.toContain("A ...");
});

test("consolidateTwoPhase WITHOUT candidates uses all consolidatable entries (parity)", async () => {
  const store = makeStoreWithEntries([entry("A ..."), entry("B ...")]);
  let seen: string[] = [];
  store.setConsolidator(async (snapshot) => { seen = snapshot.entries.map((e: any) => e.text); return { plan: { ops: [] } }; }, "test");
  await store.runConsolidatorForTest("memory");    // no candidates
  expect(seen.length).toBe(2);                     // all entries, unchanged
});
```

> `runConsolidatorForTest` is a test-only public wrapper around the private `runConsolidator` (the plan exposes it for white-box testing; OR if the file already has a test seam for consolidation, reuse it). Adapt `makeStoreWithEntries`/`entry` to the file's real helpers.

- [ ] **Step 2: Run → FAIL** (`candidates` param / test seam absent)

- [ ] **Step 3: Implement**

In `consolidateTwoPhase` (~line 455), change the signature + the `consolidatable` derivation:
```ts
  private async consolidateTwoPhase(
    target: "memory" | "user" | "failure",
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
    candidates?: string[],                       // NEW — proactive low-heat tail
  ): Promise<TwoPhaseResult> {
    if (!this.consolidator) return { consolidated: false, error: "no consolidator configured" };
    const label = this.consolidatorModelLabel ?? "default model";
    onProgress?.(`Consolidating ${target} store with ${label}… (local LLM plan; lock-free)`);
    const allEntries = this.entriesFor(target);
    const pinnedEntries = allEntries.filter((e) => this.isPinned(e));
    // NEW: when a candidate set is supplied (proactive pass), use it directly —
    // the caller (maybeProactiveConsolidate) already pin-excluded + heat-limited it.
    const consolidatable = candidates ?? (pinnedEntries.length ? allEntries.filter((e) => !this.isPinned(e)) : allEntries);
    const effectiveLimit = Math.max(0, this.charLimit(target) - pinnedEntries.join(ENTRY_DELIMITER).length);
    const heats = await this.computeHeats(target, this.heatInputsFor(target, consolidatable));
    const snapshot = buildSnapshot(target, consolidatable, effectiveLimit, heats ?? undefined);
    // … rest unchanged (consolidator call + reconcile-write) …
```
In `runConsolidator` (~line 514), thread `candidates`:
```ts
  private async runConsolidator(
    target: "memory" | "user" | "failure",
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
    candidates?: string[],                       // NEW
  ): Promise<ConsolidationResult> {
    // … existing env-guard + perfAlways wrapper …
    return await this.perfAlways(
      `consolidation.${target}`,
      () => this.consolidateTwoPhase(target, signal, onProgress, candidates),   // pass candidates
      { /* existing opts */ },
    );
    // …
```
Add a test-only public seam (or reuse an existing one) so the test can drive the private path:
```ts
  /** Test-only: run the consolidator over an optional candidate set. */
  async runConsolidatorForTest(target: "memory" | "user" | "failure", signal?: AbortSignal, onProgress?: (message: string) => void, candidates?: string[]) {
    return this.runConsolidator(target, signal, onProgress, candidates);
  }
```
> If `memory-store.ts` already exposes a test seam for consolidation, extend it instead of adding `runConsolidatorForTest`. Confirm + adapt.

- [ ] **Step 4: Run → PASS**; also run the full `tests/store/memory-store.test.ts` to confirm the overflow path (no candidates) is unchanged.
- [ ] **Step 5: Commit** — `feat(hermes-memory): candidate-limit seam on consolidateTwoPhase (backward-compatible)`

---

## Task 3: `maybeProactiveConsolidate` — pressure, cooldown, candidate selection

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts` (new method + state)
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-store.test.ts`

**Interfaces:**
- Consumes: Task 1 config; Task 2 `candidates` seam; #1b `computeHeats`/`heatOf`/`heatInputsFor`/`entriesFor`/`isPinned`.
- Produces: `async maybeProactiveConsolidate(target, signal?, onProgress?): Promise<ConsolidationResult | null>`. Returns `null` when it does not fire (disabled / cooldown / insufficient pressure / no heat). Instance state `lastProactiveRun: Map<target, number>`.

- [ ] **Step 1: Write failing tests** (append to `tests/store/memory-store.test.ts`)

```ts
test("maybeProactiveConsolidate is a no-op when disabled", async () => {
  const store = makeStoreWithHeat(/* many low-heat entries */);
  store.configure({ proactiveConsolidateEnabled: false });
  let called = 0;
  store.setConsolidator(async () => { called++; return { plan: { ops: [] } }; }, "test");
  const r = await store.maybeProactiveConsolidate("memory");
  expect(r).toBeNull();
  expect(called).toBe(0);
});

test("maybeProactiveConsolidate fires when decay-pressure >= threshold, over the bottom-K below-floor entries", async () => {
  const store = makeStoreWithHeat([
    heatEntry("hot1", 0.9), heatEntry("hot2", 0.8),
    ...Array.from({ length: 12 }, (_, i) => heatEntry(`cold${i}`, 0.05)),  // 12 below floor 0.25
  ]);
  store.configure({ proactiveConsolidateEnabled: true, proactiveHeatFloor: 0.25, proactivePressureThreshold: 10, proactiveMaxCandidates: 5, proactiveCooldownMinutes: 30 });
  let seen: string[] = [];
  store.setConsolidator(async (snap) => { seen = snap.entries.map((e:any) => e.text); return { plan: { ops: [] } }; }, "test");
  const r = await store.maybeProactiveConsolidate("memory");
  expect(r).not.toBeNull();
  expect(seen.length).toBe(5);                 // K cap
  expect(seen.every(s => s.startsWith("cold"))).toBe(true);  // only below-floor
});

test("maybeProactiveConsolidate does NOT fire when below-floor count < threshold", async () => {
  const store = makeStoreWithHeat([heatEntry("hot", 0.9), heatEntry("cold1", 0.05), heatEntry("cold2", 0.05)]);
  store.configure({ proactiveConsolidateEnabled: true, proactiveHeatFloor: 0.25, proactivePressureThreshold: 10, proactiveMaxCandidates: 5, proactiveCooldownMinutes: 30 });
  let called = 0; store.setConsolidator(async () => { called++; return { plan: { ops: [] } }; }, "test");
  expect(await store.maybeProactiveConsolidate("memory")).toBeNull();
  expect(called).toBe(0);                       // only 2 below floor < threshold 10
});

test("cooldown suppresses a second immediate pass", async () => {
  const store = makeStoreWithHeat(Array.from({ length: 12 }, (_, i) => heatEntry(`cold${i}`, 0.05)));
  store.configure({ proactiveConsolidateEnabled: true, proactiveHeatFloor: 0.25, proactivePressureThreshold: 10, proactiveMaxCandidates: 5, proactiveCooldownMinutes: 30 });
  let called = 0; store.setConsolidator(async () => { called++; return { plan: { ops: [] } }; }, "test");
  await store.maybeProactiveConsolidate("memory");   // fires
  expect(await store.maybeProactiveConsolidate("memory")).toBeNull();  // cooldown
  expect(called).toBe(1);
});
```

> Adapt `makeStoreWithHeat`/`heatEntry`/`store.configure` to the file's real fixtures. If a heat-wired store fixture doesn't exist, build one using the existing `setHeatForEntriesProvider` (#1b) + `setConsolidator`. The four tests are the contract: disabled no-op, fires-over-bottom-K, threshold gate, cooldown.

- [ ] **Step 2: Run → FAIL** (`maybeProactiveConsolidate` undefined)

- [ ] **Step 3: Implement** (in `memory-store.ts`)

```ts
  /** Per-target last proactive-run timestamp (epoch ms) for cooldown. */
  private readonly lastProactiveRun = new Map<"memory" | "user" | "failure", number>();

  /**
   * UPSP §1 proactive consolidation: if decay-pressure (count of below-heat-floor
   * entries) >= threshold and the cooldown has elapsed, fire a bounded consolidation
   * pass over the bottom-K below-floor entries. DB-free: uses the injected heat
   * provider + consolidator. The caller (write hook) checks in-flight FIRST.
   * Returns null when it does not fire; the ConsolidationResult otherwise. */
  async maybeProactiveConsolidate(
    target: "memory" | "user" | "failure",
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<ConsolidationResult | null> {
    const cfg = this.config;
    if (!cfg.proactiveConsolidateEnabled) return null;
    const now = Date.now();
    const last = this.lastProactiveRun.get(target) ?? 0;
    if (now - last < cfg.proactiveCooldownMinutes * 60_000) return null;
    // Pressure: count non-pinned entries below the heat floor.
    const all = this.entriesFor(target).filter((e) => !this.isPinned(e));
    const heats = await this.computeHeats(target, this.heatInputsFor(target, all));
    if (!heats) return null; // heat not wired / disabled → can't compute pressure
    const below = all.filter((e) => this.heatOf(e, heats) < cfg.proactiveHeatFloor);
    if (below.length < cfg.proactivePressureThreshold) return null;
    // Candidates: bottom-K below-floor, lowest heat first (decorate-with-index for a
    // stable, engine-independent sort — mirrors #1b Task 5's snapshot sort).
    const K = cfg.proactiveMaxCandidates;
    const candidates = below
      .map((e, i) => ({ e, i, h: this.heatOf(e, heats) }))
      .sort((a, b) => (a.h - b.h) || (a.i - b.i))
      .slice(0, K)
      .map((x) => x.e);
    this.lastProactiveRun.set(target, now);
    return await this.runConsolidator(target, signal, onProgress, candidates);
  }
```

> Confirm `this.config` is the live config field name + that `entriesFor`/`isPinned`/`heatInputsFor`/`computeHeats`/`heatOf` are the real method names (they are, per the #1b read). `ConsolidationResult` is already imported (line 41).

- [ ] **Step 4: Run → PASS** (all 4 trigger tests); re-run the full store test file.
- [ ] **Step 5: Commit** — `feat(hermes-memory): maybeProactiveConsolidate — decay-pressure trigger + cooldown + candidate selection`

---

## Task 4: Write-path hook — `fireProactiveIfReady` guard + wiring

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/handlers/auto-consolidate.ts` (new `fireProactiveIfReady`)
- Modify: the memory add/edit write site (confirm: `src/tools/memory-tool.ts` add/edit path; if the write completes elsewhere, wire there instead)
- Test: `bun-apps/pi-agent-ext-hermes-memory/tests/handlers/auto-consolidate.test.ts` (or nearest existing handler test)

**Interfaces:**
- Consumes: Task 3 `maybeProactiveConsolidate`; the existing `isConsolidationInFlight()` (commit-guards); Task 1 config.
- Produces: `fireProactiveIfReady(store, target, { enabled, inFlight })` — a reusable guard that, when `enabled && !inFlight()`, calls `store.maybeProactiveConsolidate(target)` **fire-and-forget** (swallows errors).

- [ ] **Step 1: Write failing test** (append to the handler test file)

```ts
test("fireProactiveIfReady: fire-and-forget when enabled + not in-flight; never throws", async () => {
  let called = 0;
  const store = { maybeProactiveConsolidate: async () => { called++; return null; } };
  fireProactiveIfReady(store as any, "memory", { enabled: true, inFlight: () => false });
  await tick();   // let the fire-and-forget microtask settle (use the file's existing async-tick helper or setTimeout(0))
  expect(called).toBe(1);
});

test("fireProactiveIfReady: no-op when disabled or in-flight", async () => {
  let called = 0;
  const store = { maybeProactiveConsolidate: async () => { called++; return null; } };
  fireProactiveIfReady(store as any, "memory", { enabled: false, inFlight: () => false });
  fireProactiveIfReady(store as any, "memory", { enabled: true, inFlight: () => true });
  await tick();
  expect(called).toBe(0);
});

test("fireProactiveIfReady swallows a rejecting maybeProactiveConsolidate (write path never breaks)", async () => {
  const store = { maybeProactiveConsolidate: async () => { throw new Error("boom"); } };
  expect(() => fireProactiveIfReady(store as any, "memory", { enabled: true, inFlight: () => false })).not.toThrow();
  await tick();
});
```

> `tick` = the file's existing async-settle helper, or `await new Promise(r => setTimeout(r, 0))`.

- [ ] **Step 2: Run → FAIL** (`fireProactiveIfReady` undefined)

- [ ] **Step 3: Implement**

In `src/handlers/auto-consolidate.ts`:
```ts
/** UPSP §1: fire-and-forget proactive consolidation after a write, guarded by the
 *  feature flag + the existing in-flight check. Never throws, never blocks the caller. */
export function fireProactiveIfReady(
  store: { maybeProactiveConsolidate(t: "memory" | "user" | "failure"): Promise<unknown> },
  target: "memory" | "user" | "failure",
  opts: { enabled: boolean; inFlight: () => boolean },
): void {
  if (!opts.enabled || opts.inFlight()) return;
  void store.maybeProactiveConsolidate(target).catch(() => {
    // best-effort: a proactive failure must never break the write path
  });
}
```
Wire it at the memory add/edit write site. In `src/tools/memory-tool.ts` (the add/edit handler), **after** a successful `addMemory`/`replaceSyncedMemories` returns, call:
```ts
  fireProactiveIfReady(store, target, {
    enabled: config.proactiveConsolidateEnabled,
    inFlight: isConsolidationInFlight,   // imported from commit-guards (or the inFlight accessor this file already uses)
  });
```
> Confirm the exact post-write line in the add/edit path + the `isConsolidationInFlight` import name this file already uses (commit-project-memory.ts resolves it to `() => process.env.PI_HERMES_CONSOLIDATING === "1"` by default — reuse the same resolution). If the real add path lives in a different file (e.g. a dedicated handler), wire it there; the contract is "called once after a successful add/edit, fire-and-forget."

- [ ] **Step 4: Run → PASS** (3 guard tests); run the memory-tool test file to confirm wiring didn't break add/edit.
- [ ] **Step 5: Commit** — `feat(hermes-memory): wire proactive-consolidation trigger fire-and-forget after memory writes`

---

## Task 5: Integration — end-to-end + parity + non-blocking

**Files:**
- Test (new): `bun-apps/pi-agent-ext-hermes-memory/tests/integration/proactive-consolidation.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: end-to-end proof that (a) disabled = no change, (b) a write under pressure triggers one bounded pass, (c) cooldown + in-flight suppress repeats, (d) the write path returns before consolidation completes (non-blocking), (e) a no-merge pass is a safe no-op.

- [ ] **Step 1: Write the integration tests**

```ts
import { test, expect } from "bun:test";
// import the real store builder + a stub consolidator + a heat provider used elsewhere in integration tests

test("disabled (default): a write never triggers a proactive pass — parity with pre-feature", async () => {
  const { store, consolidator } = await buildStoreWithHeat(/* 12 cold entries */, { proactiveConsolidateEnabled: false });
  await addEntry(store, "another cold entry");
  expect(consolidator.calls).toBe(0);
});

test("enabled + pressure: a write triggers exactly ONE bounded proactive pass over the low-heat tail", async () => {
  const { store, consolidator } = await buildStoreWithHeat(/* 12 cold entries */, { proactiveConsolidateEnabled: true, proactiveMaxCandidates: 5, proactivePressureThreshold: 10 });
  await addEntry(store, "one more");
  await settling();   // fire-and-forget settles
  expect(consolidator.calls).toBe(1);
  expect(consolidator.lastSnapshot.entries.length).toBeLessThanOrEqual(5);
});

test("cooldown + in-flight: a second write does not trigger a second pass", async () => {
  const { store, consolidator } = await buildStoreWithHeat(/* 12 cold entries */, { proactiveConsolidateEnabled: true, proactiveCooldownMinutes: 30 });
  await addEntry(store, "a"); await settling();
  markConsolidationInFlight(true);
  await addEntry(store, "b"); await settling();
  markConsolidationInFlight(false);
  await addEntry(store, "c"); await settling();   // still within cooldown
  expect(consolidator.calls).toBe(1);
});

test("non-blocking: the write resolves BEFORE the (slow) consolidation completes", async () => {
  const { store } = await buildStoreWithHeat(/* 12 cold entries */, { proactiveConsolidateEnabled: true });
  let consolidated = false;
  store.setConsolidator(async () => { await delay(200); consolidated = true; return { plan: { ops: [] } }; }, "slow");
  const t0 = Date.now();
  await addEntry(store, "x");      // write path
  const writeMs = Date.now() - t0;
  expect(writeMs).toBeLessThan(150);              // write returned fast
  expect(consolidated).toBe(false);               // consolidation still running
  await delay(300);
  expect(consolidated).toBe(true);                // eventually completed, fire-and-forget
});

test("a no-merge proactive pass loses no data", async () => {
  const { store } = await buildStoreWithHeat(/* 12 cold entries */, { proactiveConsolidateEnabled: true });
  store.setConsolidator(async () => ({ plan: { ops: [] } }), "noop");   // merge nothing
  await addEntry(store, "x"); await settling();
  expect(await countEntries(store)).toBe(/* original 12 + 1 */);        // nothing dropped
});
```

> Adapt `buildStoreWithHeat`/`addEntry`/`settling`/`markConsolidationInFlight`/`delay` to the real integration-test fixtures (mirror `tests/integration/decay-eviction.test.ts` from #1b — it built a heat-wired store + stub consolidator). `markConsolidationInFlight` flips the `isConsolidationInFlight()` source (env or the commit-guards setter).

- [ ] **Step 2: Run → FAIL** (file doesn't exist)
- [ ] **Step 3: Implement** — no production code this task (Tasks 1–4 are the implementation); this is the end-to-end harness. If a fixture gap surfaces (e.g. no heat-wired store builder), add the minimal helper here, factored to match #1b's integration test.
- [ ] **Step 4: Run → PASS** (all 5); run the FULL suite to confirm baseline parity (`proactiveConsolidateEnabled=false` default → ~1223 pass unaffected + the new tests).
- [ ] **Step 5: Commit** — `test(hermes-memory): integration — proactive consolidation end-to-end + parity + non-blocking`

---

## Self-Review (run after writing, before handoff)

- [ ] **Spec coverage:** §2 D1 (trigger on writes) → T3 (pressure/threshold) + T4 (hook); D2 (candidate set) → T3 (selection) + T2 (seam); D3 (cooldown + in-flight) → T3 (cooldown) + T4 (in-flight guard); D4 (placement) → T3 (store method) + T4 (handler hook); D5 (config) → T1. §5 Acceptance 1 (disable parity) → T1/T5; A2 (cooldown + in-flight) → T3/T5; A3 (candidate limit) → T2/T3/T5; A4 (no-merge no-op) → T5; A5 (non-blocking) → T4/T5; A6 (config parse) → T1; A7 (suite green) → all. **All decisions + acceptances mapped.**
- [ ] **Placeholder scan:** none — each task has real code/signatures. T4 acknowledges "confirm the exact post-write line" (a real locate-step, not a TBD) and T2/T3 acknowledge "adapt to the file's real fixture/helpers" (the contract tests are concrete). T5 flags a possible fixture gap with a concrete fallback (factor from #1b's integration test).
- [ ] **Type consistency:** `maybeProactiveConsolidate(target, signal?, onProgress?): Promise<ConsolidationResult | null>` defined T3, consumed T4/T5; `candidates?: string[]` defined T2, passed T3; the 5 config fields named consistently across types/constants/config/T1-tests; `fireProactiveIfReady(store, target, {enabled, inFlight})` defined T4, wired T4. `runConsolidatorForTest` test seam added T2, reused T2-tests.
- [ ] **Boundary:** T3 stores no repo import (DB-free); in-flight check is at the T4 hook (not inside the store), preserving the #1b boundary invariant.
- [ ] **Scope:** single plan, 5 tasks, each independently testable. Disable-path parity is structurally guaranteed (default `enabled=false`; `candidates` absent on the overflow path).

## Execution Handoff

Plan complete and saved to `.planning/2026-08-02-hermes-proactive-consolidation/plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session, batch with checkpoints.

Which approach?
