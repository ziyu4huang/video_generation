/**
 * Task 5 (integration) — proactive consolidation end-to-end + the two
 * properties the unit tests (T3/T4) under-covered.
 *
 *   T3 unit-tested the trigger's GATES (disabled / pressure / threshold /
 *   cooldown) with a STUB consolidator returning `{ plan: { ops: [] } }` —
 *   NO real merge. T4 unit-tested the `fireProactiveIfReady` GUARD
 *   (fire-and-forget / in-flight / swallow-rejection).
 *
 *   THIS file proves the END-TO-END merge actually applies through the real
 *   3-phase pipeline (snapshot → consolidator → locked reconcile-write) over a
 *   heat-wired MemoryStore, and pins two properties T3 left non-discriminating:
 *
 *     1. Lowest-heat ORDERING — the candidate set is the LOWEST-K below-floor
 *        entries (T3 tied all cold entries at 0.05 → could not distinguish
 *        "lowest-K" from "any-K"; here the cold heats are DISTINCT so the
 *        selection + ordering are discriminating).
 *     2. Pin protection — a pinned low-heat entry is NEVER a proactive
 *        candidate (asserted in BOTH the consolidator's snapshot AND after a
 *        reconcile-write that drops every candidate — the pin survives, as it
 *        does in the overflow path).
 *
 * Harness: the store-construction + frontmatter-seed + injected-heat-provider
 * pattern is factored from tests/integration/decay-eviction.test.ts (#1b — the
 * "stub-heat deterministic" describe block: fresh tmpdir → MemoryStore → seed
 * frontmatter entries → setHeatForEntriesProvider keyed by mdId). A consolidator
 * is injected via setConsolidator (the seam #1b does not exercise — it drives
 * the eviction FLOORS — but the proactive path drives `consolidateTwoPhase`, so
 * a consolidator is required here). The proactive pass is DB-free by contract:
 * it consumes ONLY the injected heat provider + consolidator, so no sqlite
 * backend is needed (unlike #1b's "real pipeline" goals).
 *
 * The REAL MergePlan shape used (mirrored from src/store/merge-plan.ts +
 * merge-plan.test.ts "applyMergePlan: merge replaces N present entries with one
 * new"):
 *
 *   type MergePlan = { snapshotBaseHash: string; ops: MergePlanOp[] }
 *   type MergePlanOp =
 *     | { op: "drop"; key: EntryHash; reason?: string }
 *     | { op: "merge"; fromKeys: EntryHash[]; content: string; reason?: string }
 *
 *   - `EntryHash` is the 16-hex-char sha256 of the raw encoded entry
 *     (`hashEntry(encoded)`); a `SnapshotEntry.key` already IS that hash, so the
 *     consolidator builds a merge op straight from `snapshot.entries[i].key`.
 *   - A `merge` op: drops every `fromKey` (all-or-nothing) + appends ONE freshly
 *     encoded comment-shape entry stamped `created=last=today` whose body is
 *     `content`. The reconcile re-reads disk and applies to the live set.
 *
 * All five tests assert a REAL observable (entry presence/absence, snapshot
 * membership, call count). No vacuous test.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import assert from "node:assert/strict";
import { describe, it } from "bun:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import { serializeMetadataFrontmatter } from "../../src/store/memory-format.js";
import type { ConsolidationSnapshot, MergePlan } from "../../src/store/merge-plan.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  DEFAULT_PROACTIVE_ENABLED,
  DEFAULT_PROACTIVE_HEAT_FLOOR,
  DEFAULT_PROACTIVE_MAX_CANDIDATES,
  DEFAULT_PROACTIVE_PRESSURE_THRESHOLD,
  DEFAULT_PROACTIVE_COOLDOWN_MINUTES,
  MEMORY_FILE,
} from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Date / encoding helpers (factored from decay-eviction.test.ts #1b) ───

/** "YYYY-MM-DD" for today — matches the store's frontmatter date width. */
const TODAY = new Date().toISOString().split("T")[0];

/** Frontmatter entry with a stable id + dates (mirrors the store's on-disk
 *  shape). `pin:true` only when explicitly requested. */
function fm(
  id: string,
  text: string,
  opts: { created?: string; last?: string; pin?: boolean } = {},
): string {
  const created = opts.created ?? TODAY;
  return serializeMetadataFrontmatter({
    id,
    text,
    created,
    last: opts.last ?? created,
    ...(opts.pin ? { pin: true } : {}),
  });
}

// ─── Fixture helpers (repos + store), factored from decay-eviction.test.ts ───

interface Fixture {
  dir: string;
  memoryDir: string;
  cleanup: () => Promise<void>;
}

/** Fresh temp dir (the `.md` files live in a `memory` subdir so they never
 *  collide with a lockfile / sibling artifact). */
async function makeFixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-proactive-it-"));
  const memoryDir = path.join(dir, "memory");
  const backend = null; // proactive path is DB-free (no sqlite needed here)
  void backend; // (kept the shape parallel to #1b's Fixture for clarity)
  return {
    dir,
    memoryDir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** A MemoryStore rooted at `memoryDir`. The five proactive knobs default to the
 *  PRODUCTION defaults (OFF) so a test that adds NO override exercises the
 *  real disable path; enabling tests override them explicitly. */
function makeStore(memoryDir: string, overrides: Partial<MemoryConfig> = {}): MemoryStore {
  return new MemoryStore({
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    memoryDir,
    proactiveConsolidateEnabled: DEFAULT_PROACTIVE_ENABLED,
    proactiveHeatFloor: DEFAULT_PROACTIVE_HEAT_FLOOR,
    proactiveMaxCandidates: DEFAULT_PROACTIVE_MAX_CANDIDATES,
    proactivePressureThreshold: DEFAULT_PROACTIVE_PRESSURE_THRESHOLD,
    proactiveCooldownMinutes: DEFAULT_PROACTIVE_COOLDOWN_MINUTES,
    ...overrides,
  } as MemoryConfig);
}

/** Seed frontmatter entries (in the given disk/file order) into MEMORY.md. */
async function seedMemory(memoryDir: string, entries: string[]): Promise<void> {
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, MEMORY_FILE), entries.join(ENTRY_DELIMITER), "utf-8");
}

// ─── Proactive store setup (heat-wired + seeded from a spec) ───

/** A cold (below-floor) entry spec: a unique `tag` (the body, also the
 *  presence/absence discriminator) + its heat + optional pin. */
interface ColdSpec {
  tag: string;
  heat: number;
  pin?: boolean;
}
/** A hot (above-floor) entry spec. */
interface HotSpec {
  tag: string;
  heat: number;
}

interface ProactiveSetup {
  store: MemoryStore;
  /** mdId → heat (the same map the provider closes over). */
  idToHeat: Map<string, number>;
  /** All cold entries, in seed order, with their minted mdId + tag + heat + pin. */
  cold: { id: string; tag: string; heat: number; pin?: boolean }[];
  /** All hot entries, with their minted mdId + tag + heat. */
  hot: { id: string; tag: string; heat: number }[];
}

/** Build a heat-wired MemoryStore seeded with the given cold (below-floor) +
 *  hot (above-floor) entries. Mirrors #1b's stub-heat block: frontmatter seed +
 *  setHeatForEntriesProvider keyed by mdId. Each entry gets a real uuid mdId. */
async function setupProactiveStore(
  memoryDir: string,
  config: Partial<MemoryConfig>,
  coldSpecs: ColdSpec[],
  hotSpecs: HotSpec[] = [],
): Promise<ProactiveSetup> {
  const idToHeat = new Map<string, number>();
  const cold: ProactiveSetup["cold"] = [];
  const hot: ProactiveSetup["hot"] = [];
  const encoded: string[] = [];
  for (const c of coldSpecs) {
    const id = crypto.randomUUID();
    cold.push({ id, ...c });
    idToHeat.set(id, c.heat);
    encoded.push(fm(id, c.tag, c.pin ? { pin: true } : {}));
  }
  for (const h of hotSpecs) {
    const id = crypto.randomUUID();
    hot.push({ id, ...h });
    idToHeat.set(id, h.heat);
    encoded.push(fm(id, h.tag));
  }
  await seedMemory(memoryDir, encoded);

  const store = makeStore(memoryDir, config);
  store.setHeatForEntriesProvider(async (_t, inputs) => {
    const m = new Map<string, number>();
    for (const input of inputs) {
      const h = idToHeat.get(input.mdId);
      if (h !== undefined) m.set(input.mdId, h);
    }
    return m;
  });
  await store.loadFromDisk();
  return { store, idToHeat, cold, hot };
}

/** Wrap setup so each test owns + cleans its own tmpdir. */
async function withStore(
  config: Partial<MemoryConfig>,
  coldSpecs: ColdSpec[],
  hotSpecs: HotSpec[],
  fn: (setup: ProactiveSetup & { cleanup: () => Promise<void> }) => Promise<void>,
): Promise<void> {
  const fx = await makeFixture();
  try {
    const setup = await setupProactiveStore(fx.memoryDir, config, coldSpecs, hotSpecs);
    await fn({ ...setup, cleanup: fx.cleanup });
  } finally {
    await fx.cleanup();
  }
}

/** "≥12 below-floor entries" fixture: 12 cold entries with DISTINCT heats spread
 *  under floor 0.25 (0.01 … 0.23) + 2 hot (0.90, 0.85). The distinct cold heats
 *  make "lowest-K" selection discriminating (the property T3's tied-0.05 test
 *  could not pin). */
const COLD_DISTINCT_HEATS = [0.01, 0.03, 0.05, 0.07, 0.09, 0.11, 0.13, 0.15, 0.17, 0.19, 0.21, 0.23];
function distinctColdSpecs(): ColdSpec[] {
  return COLD_DISTINCT_HEATS.map((heat, i) => ({ tag: `COLD-h${i}-${heat}`, heat }));
}
const HOT_SPECS: HotSpec[] = [
  { tag: "HOT-0.90", heat: 0.9 },
  { tag: "HOT-0.85", heat: 0.85 },
];

/** Assert at least one live entry contains `marker`. */
function assertPresent(entries: string[], marker: string, msg?: string): void {
  assert.ok(entries.some((e) => e.includes(marker)), `expected entry present: ${marker}${msg ? ` — ${msg}` : ""}`);
}
/** Assert NO live entry contains `marker`. */
function assertAbsent(entries: string[], marker: string, msg?: string): void {
  assert.ok(!entries.some((e) => e.includes(marker)), `expected entry ABSENT: ${marker}${msg ? ` — ${msg}` : ""}`);
}

/** Proactive config: ENABLED, K cap, floor 0.25, pressure threshold 10, 30-min
 *  cooldown. K=5 so the bottom-K selection is observable (12 below-floor). */
function proactiveOn(overrides: Partial<MemoryConfig> = {}): Partial<MemoryConfig> {
  return {
    proactiveConsolidateEnabled: true,
    proactiveHeatFloor: 0.25,
    proactivePressureThreshold: 10,
    proactiveMaxCandidates: 5,
    proactiveCooldownMinutes: 30,
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("proactive consolidation — end-to-end + lowest-heat ordering + pin protection", () => {
  it("end-to-end: pressure → proactive pass applies a REAL merge (consumed entries dropped, merged entry present)", async () => {
    await withStore(proactiveOn(), distinctColdSpecs(), HOT_SPECS, async ({ store }) => {
      // The consolidator captures the snapshot, then returns a REAL MergePlan
      // that MERGES the two lowest-heat candidates (snapshot.entries[0/1],
      // guaranteed in-snapshot since they are the coldest) into one new entry.
      // This drives the full reconcile-write (step 3): applyMergePlan drops the
      // two fromKeys + appends one freshly-encoded entry.
      let seen: ConsolidationSnapshot | null = null;
      let calls = 0;
      store.setConsolidator(async (snapshot) => {
        calls++;
        seen = snapshot;
        const [a, b] = snapshot.entries;
        const plan: MergePlan = {
          snapshotBaseHash: snapshot.snapshotBaseHash,
          ops: [{ op: "merge", fromKeys: [a.key, b.key], content: "MERGED-PROACTIVE-E2E-RESULT" }],
        };
        return { plan };
      }, "test");

      const result = await store.maybeProactiveConsolidate("memory");

      // The pass FIRED (non-null) and the plan APPLIED (≥1 op took effect).
      assert.ok(result, "proactive pass fired (non-null result)");
      assert.equal(result.consolidated, true, "the real merge plan applied (≥1 op took effect)");
      assert.equal(calls, 1, "consolidator called exactly once");

      // The snapshot was the bottom-K (5) below-floor entries, heat-sorted.
      assert.ok(seen, "consolidator received a snapshot");
      assert.equal(seen!.entries.length, 5, "K cap: bottom-5 below-floor candidates");
      const [mergedA, mergedB] = [seen!.entries[0].content, seen!.entries[1].content];

      // End-to-end observable: the two CONSUMED entries are GONE and the merged
      // entry IS present in the live store (the reconcile-write dropped them +
      // appended the merge result).
      const entries = store.getMemoryEntries();
      assertAbsent(entries, mergedA, "first merged source dropped by the reconcile-write");
      assertAbsent(entries, mergedB, "second merged source dropped by the reconcile-write");
      assertPresent(entries, "MERGED-PROACTIVE-E2E-RESULT", "merged entry appended by the reconcile-write");
    });
  });

  it("end-to-end: a no-merge proactive pass loses NO data", async () => {
    await withStore(proactiveOn(), distinctColdSpecs(), HOT_SPECS, async ({ store }) => {
      let calls = 0;
      store.setConsolidator(async (snapshot) => {
        calls++;
        // Empty plan: nothing dropped, nothing merged.
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      }, "test");

      const before = store.getMemoryEntries();
      const result = await store.maybeProactiveConsolidate("memory");
      const after = store.getMemoryEntries();

      // The pass FIRED (consolidator called, non-null result) but the live store
      // is byte-unchanged — a no-op plan loses zero entries.
      assert.ok(result, "proactive pass fired (non-null result)");
      assert.equal(calls, 1, "consolidator called exactly once");
      assert.equal(after.length, before.length, "entry count unchanged after a no-merge pass");
      assert.deepEqual(after, before, "no entry content changed after a no-merge pass");
    });
  });

  it("lowest-heat ordering: the candidate set is the LOWEST-K below-floor entries (varied heats)", async () => {
    await withStore(proactiveOn(), distinctColdSpecs(), HOT_SPECS, async ({ store, cold, hot, idToHeat }) => {
      // 12 cold with DISTINCT heats (0.01 … 0.23) + 2 hot. K=5. The 5 LOWEST-
      // heat cold entries MUST be the candidates; the 7 higher-cold + 2 hot
      // MUST be absent. Distinct heats make "lowest-K" vs "any-K" discriminating
      // (a bug that picked the 5 HIGHEST below-floor, or any arbitrary 5, would
      // fail the exact-set assertion).
      let seen: ConsolidationSnapshot | null = null;
      let calls = 0;
      store.setConsolidator(async (snapshot) => {
        calls++;
        seen = snapshot;
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      }, "test");

      const result = await store.maybeProactiveConsolidate("memory");
      assert.ok(result, "proactive pass fired");
      assert.equal(calls, 1);

      // Sort the cold specs by heat to derive the expected 5 lowest + 7 higher.
      const byHeatAsc = [...cold].sort((a, b) => a.heat - b.heat);
      const expectedLowest5 = byHeatAsc.slice(0, 5); // 0.01,0.03,0.05,0.07,0.09
      const expectedHigher7 = byHeatAsc.slice(5); // 0.11 … 0.23

      const seenIds = seen!.entries.map((e) => e.mdId);
      assert.equal(seen!.entries.length, 5, "exactly K=5 candidates");
      // EXACT set: the 5 candidates are the 5 LOWEST-heat cold entries.
      assert.deepEqual(
        [...seenIds].sort(),
        expectedLowest5.map((c) => c.id).sort(),
        "candidate set is EXACTLY the 5 lowest-heat below-floor entries",
      );
      // ORDER: ascending by heat (the snapshot is heat-sorted, lowest-first).
      assert.deepEqual(
        seenIds,
        expectedLowest5.map((c) => c.id),
        "candidates are ordered LOWEST-heat-first (distinct heats → discriminating)",
      );
      // The 7 higher-cold + 2 hot are all ABSENT.
      for (const c of expectedHigher7) {
        assert.ok(!seenIds.includes(c.id), `higher-cold entry (${c.heat}) NOT a candidate`);
      }
      for (const h of hot) {
        assert.ok(!seenIds.includes(h.id), `hot entry (${h.heat}) NOT a candidate`);
      }
      // Non-vacuous guard: the 5 lowest + 7 higher are genuinely disjoint sets
      // (the distinct heats guarantee it).
      const lowestSet = new Set(expectedLowest5.map((c) => c.id));
      const higherSet = new Set(expectedHigher7.map((c) => c.id));
      assert.equal([...lowestSet].filter((id) => higherSet.has(id)).length, 0, "lowest-5 / higher-7 disjoint");
      // And the seen heats are strictly ascending (proves ordering, not just set).
      const seenHeats = seen!.entries.map((e) => idToHeat.get(e.mdId as string));
      assert.deepEqual(seenHeats, [...seenHeats].sort((a, b) => (a as number) - (b as number)), "seen heats strictly ascending");
    });
  });

  it("pin protection: a pinned low-heat entry is NEVER a proactive candidate", async () => {
    // 12 below-floor entries. The COLDEST (heat 0.005) is PINNED — its heat-rank
    // would place it FIRST in the bottom-K were it not pinned. K=5 covers it.
    // Assert: the pinned mdId is NOT in the consolidator's snapshot, AND it
    // SURVIVES a reconcile-write that drops every candidate (pin protects in the
    // proactive path exactly as it does in overflow).
    const specs: ColdSpec[] = [];
    // pinned coldest first (heat 0.005), then the 12 distinct cold heats.
    specs.push({ tag: "PINNED-COLDEST-0.005", heat: 0.005, pin: true });
    for (const heat of COLD_DISTINCT_HEATS) specs.push({ tag: `COLD-${heat}`, heat });
    // specs now = 13 below-floor entries (1 pinned + 12 cold) — the pinned one
    // is the COLDEST so its heat-rank would place it first in the bottom-K.

    await withStore(proactiveOn(), specs, [], async ({ store, cold }) => {
      const pinned = cold.find((c) => c.pin)!;
      assert.ok(pinned, "fixture: a pinned coldest entry exists");

      let seen: ConsolidationSnapshot | null = null;
      let calls = 0;
      store.setConsolidator(async (snapshot) => {
        calls++;
        seen = snapshot;
        // Drop EVERY candidate — if pin did not protect, the pinned entry (the
        // coldest) would be a candidate and would be dropped here.
        const plan: MergePlan = {
          snapshotBaseHash: snapshot.snapshotBaseHash,
          ops: snapshot.entries.map((e) => ({ op: "drop" as const, key: e.key })),
        };
        return { plan };
      }, "test");

      const result = await store.maybeProactiveConsolidate("memory");
      assert.ok(result, "proactive pass fired");
      assert.equal(calls, 1);

      // (1) Pin-exclusion: the pinned mdId is NOT in the candidate snapshot.
      const seenIds = seen!.entries.map((e) => e.mdId);
      assert.ok(!seenIds.includes(pinned.id), "pinned entry is NOT a proactive candidate (excluded from snapshot)");

      // (2) Pin-survives-reconcile: after dropping every candidate, the pinned
      // entry is STILL present in the live store.
      const entries = store.getMemoryEntries();
      assertPresent(entries, pinned.tag, "pinned entry SURVIVES the proactive reconcile-write");
      // And at least one dropped candidate is genuinely gone (proves the plan
      // applied — the pin-survival assertion is not vacuous).
      const aDroppedCandidate = cold.filter((c) => !c.pin).sort((a, b) => a.heat - b.heat)[0];
      assertAbsent(entries, aDroppedCandidate.tag, "a dropped candidate is gone (proves the drop plan applied)");
    });
  });

  it("disable parity (default off): maybeProactiveConsolidate returns null, no consolidation, no data change", async () => {
    // DEFAULT config — proactiveConsolidateEnabled is FALSE (the production
    // default). The same ≥12-below-floor pressure that fires above must NOT
    // fire here: the method short-circuits on the flag with NO side effects.
    await withStore({}, distinctColdSpecs(), HOT_SPECS, async ({ store }) => {
      let calls = 0;
      store.setConsolidator(async (snapshot) => {
        calls++;
        return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } };
      }, "test");

      const before = store.getMemoryEntries();
      const result = await store.maybeProactiveConsolidate("memory");
      const after = store.getMemoryEntries();

      assert.equal(result, null, "disabled → maybeProactiveConsolidate returns null");
      assert.equal(calls, 0, "disabled → consolidator NEVER called (no pass scheduled)");
      assert.deepEqual(after, before, "disabled → live store byte-unchanged (baseline parity)");
    });
  });
});
