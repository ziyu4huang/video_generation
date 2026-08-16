/**
 * Task 6 (integration) — end-to-end proof that eviction is heat-ordered
 * (UPSP §1, ticket #1b decay).
 *
 * Deterministic, no consolidator wired → overflow hits the
 * `vaultOffloadAndAdd` (add) / `vaultOffloadAndReplace` (replace) floors
 * directly (NOT the LLM path), so the evicted md_id sequence is fully
 * reproducible. Five goals, each covered:
 *
 *  1. **Real-pipeline heat ordering** — seed real `mw_success`/`mw_fail`
 *     (memoryRepo) + `used_at` (sessionRepo via recordAssembly+markUsed) +
 *     entry dates → overflow → the evicted set is lowest-heat-first; a
 *     high-worth+used+recent entry SURVIVES a low-worth+unused+stale one.
 *  2. **Stub-heat deterministic** — fix the heat-provider to a known Map →
 *     assert the EXACT evicted md_id sequence is heat-ascending (no date/mw
 *     math in the assertion — full control).
 *  3. **Both floors** — `vaultOffloadAndAdd` (add overflow) AND
 *     `vaultOffloadAndReplace` (replace overflow), each heat-ordered.
 *  4. **Disable-path parity** — `decayEnabled === false` → provider NOT wired
 *     → eviction order is byte-identical to pre-#1b FIFO (and to a raw
 *     no-provider reference); when decay IS on + a reordering provider is
 *     wired, the order DIFFERS (the gate is meaningful).
 *  5. **Used outranks unused at equal recency** — two entries same
 *     `lastReferenced`, one marked used (markUsed) → the unused one is evicted
 *     first (the `used_at` signal flows through `makeHeatProvider` →
 *     `computeHeat`'s usedBonus).
 *
 * These are characterization tests: the #1b implementation is already landed,
 * so they assert the GREEN (heat-ordered) behavior. If any assertion fails it
 * reveals a real wiring/ordering bug (reported, never papered over).
 *
 * Determinism notes:
 *  - `computeHeat` builds `now = new Date()` internally; tests use DAY-scale
 *    recency gaps so sub-second wall-clock drift cannot flip an ordering.
 *  - `memoryCharLimit` is computed from the REAL encoded entry sizes (via a
 *    length-identical template) so a precise number of evictions is forced
 *    without manual char tuning — robust to frontmatter overhead changes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import assert from "node:assert/strict";
import { describe, it } from "bun:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { SqliteSessionRepository } from "../../src/store/sqlite/sqlite-session-repo.js";
import { serializeMetadataFrontmatter } from "../../src/store/memory-format.js";
import { makeHeatProvider, shouldWireHeat } from "../../src/handlers/heat-provider.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  MEMORY_FILE,
} from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Date / id / encoding helpers ───

/** "YYYY-MM-DD" for `n` days before today (0 = today). Day-scale, so the few-ms
 *  gap between seeding and the provider's internal `new Date()` is immaterial. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}
const TODAY = daysAgo(0);

/** A canonical 36-char uuid-shape string. The store mints a real v4 uuid (also
 *  36 chars) at encode time, so a template built with this id is LENGTH-
 *  IDENTICAL to the store's own encoding for the same body + dates — the basis
 *  for the self-tuning limit computation below. */
const SHAPE_UUID = "00000000-0000-4000-8000-000000000000";

/** Build a frontmatter entry matching the store's `encodeEntry` output shape
 *  (id 36 chars, created/last "YYYY-MM-DD") for a given body. The length always
 *  equals the store's encoding of the same body (the date VALUE never changes
 *  the 10-char width), so it is safe for size math. */
function encodeTemplate(body: string, created = TODAY, last = TODAY): string {
  return serializeMetadataFrontmatter({ id: SHAPE_UUID, text: body, created, last });
}

/** Frontmatter entry with a stable id + dates (mirrors the store's on-disk
 *  shape). `pin:true` only when explicitly requested. */
function fm(
  id: string,
  body: string,
  opts: { created?: string; last?: string; pin?: boolean } = {},
): string {
  const created = opts.created ?? TODAY;
  return serializeMetadataFrontmatter({
    id,
    text: body,
    created,
    last: opts.last ?? created,
    ...(opts.pin ? { pin: true } : {}),
  });
}

/** Distinct, EQUAL-LENGTH body strings (each is its own label repeated to
 *  `targetLen`). Equal length makes "remove any k entries" reduce the joined
 *  size by the same amount regardless of WHICH entries are removed — so ONE
 *  limit forces the same eviction COUNT under both FIFO and heat ordering
 *  (essential for the disable-vs-enable parity comparison). Repetition of a
 *  per-entry label keeps cross-entry similarity low (no false overlap). */
function body(label: string, targetLen = 60): string {
  let out = label;
  while (out.length < targetLen) out += " " + label;
  return out.slice(0, targetLen);
}

/** Joined length of a list of encoded entries (delimited as the store measures). */
function joinLen(xs: string[]): number {
  return xs.length ? xs.join(ENTRY_DELIMITER).length : 0;
}

/** `memoryCharLimit` that forces EXACTLY the eviction of `evictOrder` (the k
 *  lowest-heat entries, in eviction order) when `incomingBody` is added to the
 *  seeded set. limit == joined length AFTER those k land (self-tuning from real
 *  entry sizes via a length-identical incoming template); removing one fewer
 *  entry still overflows, so exactly k are evicted. */
function addLimitForEvictions(
  seeded: string[],
  evictOrder: string[],
  incomingBody: string,
): number {
  const evict = new Set(evictOrder);
  const survivors = seeded.filter((e) => !evict.has(e));
  return joinLen([...survivors, encodeTemplate(incomingBody)]);
}

/** `memoryCharLimit` that forces EXACTLY the eviction of `evictedOthers` (the k
 *  lowest-heat OTHER entries) when the protected entry at `protectedIdx` is
 *  replaced by `grownBody`. limit == joined length AFTER the k others leave
 *  (protected replaced by the grown template); removing one fewer still
 *  overflows. The store re-encodes the replacement with the protected entry's
 *  `created` + today's `last`, both 10-char dates → length matches the template. */
function replaceLimitForEvictions(
  seeded: string[],
  protectedIdx: number,
  grownBody: string,
  evictedOthers: string[],
  created = TODAY,
): number {
  const evict = new Set(evictedOthers);
  const survivors: string[] = [];
  for (let i = 0; i < seeded.length; i++) {
    if (i === protectedIdx) survivors.push(encodeTemplate(grownBody, created, TODAY));
    else if (!evict.has(seeded[i])) survivors.push(seeded[i]);
  }
  return joinLen(survivors);
}

// ─── Fixture helpers (repos + store) ───

interface Fixture {
  dir: string;
  memoryDir: string;
  backend: SqliteBackend;
  memoryRepo: SqliteMemoryRepository;
  sessionRepo: SqliteSessionRepository;
  cleanup: () => Promise<void>;
}

/** Fresh temp dir + real sqlite backend + both repos. `memoryDir` is a subdir
 *  so the `.md` files never collide with the sqlite db file. */
async function makeFixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-decay-it-"));
  const memoryDir = path.join(dir, "memory");
  const backend = new SqliteBackend(dir);
  await backend.init();
  const memoryRepo = new SqliteMemoryRepository(backend);
  const sessionRepo = new SqliteSessionRepository(backend);
  return {
    dir,
    memoryDir,
    backend,
    memoryRepo,
    sessionRepo,
    cleanup: async () => {
      backend.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/** A MemoryStore rooted at `memoryDir` (the `decay*` knobs resolve to their
 *  DEFAULTs inside `makeHeatProvider` when unset). */
function makeStore(memoryDir: string, overrides: Partial<MemoryConfig> = {}): MemoryStore {
  return new MemoryStore({
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    memoryDir,
    ...overrides,
  } as MemoryConfig);
}

/** Seed frontmatter entries (in the given disk/file order) into MEMORY.md. */
async function seedMemory(memoryDir: string, entries: string[]): Promise<void> {
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, MEMORY_FILE), entries.join(ENTRY_DELIMITER), "utf-8");
}

// ─── IDs (stable, distinct uuids) ───
const HOT_ID = "11111111-1111-4111-8111-111111111111";
const MID_ID = "22222222-2222-4222-8222-222222222222";
const COLD_ID = "33333333-3333-4333-8333-333333333333";
const USED_ID = "44444444-4444-4444-8444-444444444444";
const UNUSED_ID = "55555555-5555-4555-8555-555555555555";
const HIGH_ID = "66666666-6666-4666-8666-666666666666";
const LOW_ID = "77777777-7777-4777-8777-777777777777";
const A_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const B_ID = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const C_ID = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";

// ===========================================================================
// 1 + 3 + 5 — REAL PIPELINE (makeHeatProvider + real sqlite repos)
// ===========================================================================

describe("decay eviction — real pipeline (makeHeatProvider + sqlite repos)", () => {
  it("goal1: a high-worth+used+recent entry SURVIVES a low-worth+unused+stale one (add floor, heat-ascending)", async () => {
    const fx = await makeFixture();
    try {
      // .md entries — recency via dates; worth/used come from the DB below.
      const HOT = fm(HOT_ID, body("HOT-recent-highworth-used-survivor"), { last: daysAgo(1) });
      const MID = fm(MID_ID, body("MID-medium-neutral-worth-probe"), { last: daysAgo(14) });
      const COLD = fm(COLD_ID, body("COLD-stale-lowworth-unused-evictee"), { last: daysAgo(90) });
      // file order HOT, MID, COLD — FIFO would evict HOT first; HEAT must evict
      // COLD first (proving the provider is actually wired, not just FIFO).
      await seedMemory(fx.memoryDir, [HOT, MID, COLD]);

      // Real worth rows (memoryRepo) keyed by the same mdIds.
      await fx.memoryRepo.syncMemoryEntry({ content: `db-${HOT_ID}`, target: "memory", project: null, mdId: HOT_ID, mwSuccess: 20, mwFail: 0 });
      await fx.memoryRepo.syncMemoryEntry({ content: `db-${MID_ID}`, target: "memory", project: null, mdId: MID_ID, mwSuccess: 5, mwFail: 5 });
      await fx.memoryRepo.syncMemoryEntry({ content: `db-${COLD_ID}`, target: "memory", project: null, mdId: COLD_ID, mwSuccess: 0, mwFail: 20 });

      // Real used_at signal (sessionRepo): HOT was content-matched → usedBonus.
      await fx.sessionRepo.recordAssembly("sess-1", [HOT_ID, MID_ID, COLD_ID], "hash-1");
      await fx.sessionRepo.markUsed("sess-1", [HOT_ID], new Date().toISOString());

      const incoming = body("NEW-incoming-real-overflow-probe");
      // Force EXACTLY two evictions: the two coldest (COLD then MID); HOT stays.
      const limit = addLimitForEvictions([HOT, MID, COLD], [COLD, MID], incoming);

      const store = makeStore(fx.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "vault-offload" });
      store.setHeatForEntriesProvider(makeHeatProvider({ decayEnabled: true }, { memoryRepo: fx.memoryRepo, sessionRepo: fx.sessionRepo }, null));
      await store.loadFromDisk();

      const result = await store.add("memory", incoming);
      assert.ok(result.success, result.error);

      assert.equal(result.evicted_count, 2, "exactly the two coldest entries are evicted");
      assert.deepEqual(result.evicted_md_ids, [COLD_ID, MID_ID], "eviction order is heat-ASCENDING (coldest→warmest)");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("HOT-recent-highworth-used")), "high-worth+used+recent entry SURVIVES");
      assert.ok(!entries.some((e) => e.includes("COLD-stale-lowworth")), "low-worth+unused+stale entry evicted first");
      assert.ok(!entries.some((e) => e.includes("MID-medium-neutral")), "medium entry evicted second");
    } finally {
      await fx.cleanup();
    }
  });

  it("goal5: at EQUAL recency, a USED entry outranks an UNUSED one (real used_at → usedBonus)", async () => {
    const fx = await makeFixture();
    try {
      // Same lastReferenced (30d ago) → equal recency spine. No worth rows →
      // neutral Laplace 0.5 for BOTH (worthMult 1.0). The ONLY difference is the
      // used_at signal: USED was markUsed, UNUSED was not → usedBonus separates
      // them. recencySpine(30d)=~0.12, so +0.1 usedBonus cannot clamp away.
      const rec = daysAgo(30);
      const USED = fm(USED_ID, body("USED-survivor-equal-recency-probe"), { last: rec });
      const UNUSED = fm(UNUSED_ID, body("UNUSED-evictee-equal-recency-probe"), { last: rec });
      await seedMemory(fx.memoryDir, [USED, UNUSED]);

      // No worth rows (neutral). Only the used_at signal differs.
      await fx.sessionRepo.recordAssembly("sess-5", [USED_ID, UNUSED_ID], "hash-5");
      await fx.sessionRepo.markUsed("sess-5", [USED_ID], new Date().toISOString());

      const incoming = body("NEW-incoming-used-signal-probe");
      // Force EXACTLY one eviction: the unused entry.
      const limit = addLimitForEvictions([USED, UNUSED], [UNUSED], incoming);

      const store = makeStore(fx.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "vault-offload" });
      store.setHeatForEntriesProvider(makeHeatProvider({ decayEnabled: true }, { memoryRepo: fx.memoryRepo, sessionRepo: fx.sessionRepo }, null));
      await store.loadFromDisk();

      const result = await store.add("memory", incoming);
      assert.ok(result.success, result.error);

      assert.deepEqual(result.evicted_md_ids, [UNUSED_ID], "UNUSED evicted; USED spared at equal recency");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("USED-survivor")), "used entry survives");
      assert.ok(!entries.some((e) => e.includes("UNUSED-evictee")), "unused entry evicted");
    } finally {
      await fx.cleanup();
    }
  });

  it("goal1: the worth signal alone reorders eviction (high-worth survives low-worth at equal recency)", async () => {
    const fx = await makeFixture();
    try {
      // Equal recency (7d); no used signal. The ONLY differentiator is mw_*.
      const rec = daysAgo(7);
      const HIGH = fm(HIGH_ID, body("HIGH-worth-survivor-equal-recency"), { last: rec });
      const LOW = fm(LOW_ID, body("LOW-worth-evictee-equal-recency"), { last: rec });
      await seedMemory(fx.memoryDir, [HIGH, LOW]);

      await fx.memoryRepo.syncMemoryEntry({ content: `db-${HIGH_ID}`, target: "memory", project: null, mdId: HIGH_ID, mwSuccess: 100, mwFail: 0 });
      await fx.memoryRepo.syncMemoryEntry({ content: `db-${LOW_ID}`, target: "memory", project: null, mdId: LOW_ID, mwSuccess: 0, mwFail: 100 });

      const incoming = body("NEW-incoming-worth-only-probe");
      const limit = addLimitForEvictions([HIGH, LOW], [LOW], incoming);

      const store = makeStore(fx.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "vault-offload" });
      store.setHeatForEntriesProvider(makeHeatProvider({ decayEnabled: true }, { memoryRepo: fx.memoryRepo, sessionRepo: fx.sessionRepo }, null));
      await store.loadFromDisk();

      const result = await store.add("memory", incoming);
      assert.ok(result.success, result.error);

      assert.deepEqual(result.evicted_md_ids, [LOW_ID], "low-worth evicted; high-worth spared at equal recency");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("HIGH-worth-survivor")), "high-worth entry survives");
      assert.ok(!entries.some((e) => e.includes("LOW-worth-evictee")), "low-worth entry evicted");
    } finally {
      await fx.cleanup();
    }
  });

  it("goal3: replace floor — real pipeline evicts the LOWEST-heat OTHER (heat beats file-order)", async () => {
    const fx = await makeFixture();
    try {
      // File order A(protected), B, C. Equal recency; B high-worth, C low-worth.
      // FIFO would evict B (oldest OTHER); HEAT must evict C (lowest-heat OTHER).
      const rec = daysAgo(7);
      const A = fm(A_ID, body("A-protected-replace-floor-probe"), { last: rec });
      const B = fm(B_ID, body("B-high-worth-other-survives"), { last: rec });
      const C = fm(C_ID, body("C-low-worth-other-evictee"), { last: rec });
      await seedMemory(fx.memoryDir, [A, B, C]);

      await fx.memoryRepo.syncMemoryEntry({ content: `db-${A_ID}`, target: "memory", project: null, mdId: A_ID, mwSuccess: 0, mwFail: 0 });
      await fx.memoryRepo.syncMemoryEntry({ content: `db-${B_ID}`, target: "memory", project: null, mdId: B_ID, mwSuccess: 100, mwFail: 0 });
      await fx.memoryRepo.syncMemoryEntry({ content: `db-${C_ID}`, target: "memory", project: null, mdId: C_ID, mwSuccess: 0, mwFail: 100 });

      // Grow A so the replacement overflows by exactly one OTHER entry.
      const grown = body("A-protected-replace-floor-GROWN-to-overflow-now-zzzzz");
      // Force EXACTLY one eviction of C (the lowest-heat OTHER); A is protected.
      const limit = replaceLimitForEvictions([A, B, C], 0, grown, [C], rec);

      const store = makeStore(fx.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "auto-consolidate" });
      store.setHeatForEntriesProvider(makeHeatProvider({ decayEnabled: true }, { memoryRepo: fx.memoryRepo, sessionRepo: fx.sessionRepo }, null));
      await store.loadFromDisk();

      const result = await store.replace("memory", "A-protected-replace-floor-probe", grown);
      assert.ok(result.success, result.error);

      assert.deepEqual(result.evicted_md_ids, [C_ID], "lowest-heat OTHER (C) evicted, NOT the file-order-oldest other (B)");
      const entries = store.getMemoryEntries();
      assert.ok(entries.some((e) => e.includes("GROWN-to-overflow")), "grown replacement landed");
      assert.ok(entries.some((e) => e.includes("B-high-worth-other")), "higher-worth OTHER (B) survives");
      assert.ok(!entries.some((e) => e.includes("C-low-worth-other")), "lowest-worth OTHER (C) evicted");
    } finally {
      await fx.cleanup();
    }
  });
});

// ===========================================================================
// 2 + 3 — STUB-HEAT DETERMINISTIC (fixed Map → exact heat-ascending sequence)
// ===========================================================================

describe("decay eviction — stub-heat deterministic (fixed Map → exact sequence)", () => {
  it("goal2: add floor — the EXACT evicted md_id sequence is heat-ascending (full control)", async () => {
    const fx = await makeFixture();
    try {
      // File order deliberately NOT heat order, so a non-trivial reordering is
      // observable. Stub returns a fixed Map → no date/mw math in the assertion.
      const HOT = fm(HOT_ID, body("HOT-stub-survivor-seq-probe"));
      const MID = fm(MID_ID, body("MID-stub-middle-seq-probe"));
      const COLD = fm(COLD_ID, body("COLD-stub-evictee-seq-probe"));
      await seedMemory(fx.memoryDir, [HOT, MID, COLD]); // file order HOT, MID, COLD

      const incoming = body("NEW-stub-incoming-seq-probe");
      const limit = addLimitForEvictions([HOT, MID, COLD], [COLD, MID], incoming);

      const store = makeStore(fx.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "vault-offload" });
      store.setHeatForEntriesProvider(async (_t, entries) => {
        const m = new Map<string, number>();
        for (const e of entries) {
          if (e.mdId === HOT_ID) m.set(HOT_ID, 0.9);
          if (e.mdId === MID_ID) m.set(MID_ID, 0.5);
          if (e.mdId === COLD_ID) m.set(COLD_ID, 0.1);
        }
        return m;
      });
      await store.loadFromDisk();

      const result = await store.add("memory", incoming);
      assert.ok(result.success, result.error);

      assert.equal(result.evicted_count, 2);
      assert.deepEqual(result.evicted_md_ids, [COLD_ID, MID_ID], "exact sequence is heat-ascending (0.1 → 0.5); hottest (0.9) survives");
    } finally {
      await fx.cleanup();
    }
  });

  it("goal3: replace floor — stub heat evicts the lowest-heat OTHER (heat overrides file-order)", async () => {
    const fx = await makeFixture();
    try {
      // File order A(protected), B, C. Stub: B hot, C cold. FIFO would evict B;
      // heat must evict C. Proves the replace floor consumes the heat Map.
      const A = fm(A_ID, body("A-stub-protected-replace-probe"));
      const B = fm(B_ID, body("B-stub-hot-other-survives"));
      const C = fm(C_ID, body("C-stub-cold-other-evictee"));
      await seedMemory(fx.memoryDir, [A, B, C]);

      const grown = body("A-stub-protected-replace-GROWN-to-overflow-zzzzzz");
      const limit = replaceLimitForEvictions([A, B, C], 0, grown, [C]);

      const store = makeStore(fx.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "auto-consolidate" });
      store.setHeatForEntriesProvider(async (_t, entries) => {
        const m = new Map<string, number>();
        for (const e of entries) {
          if (e.mdId === A_ID) m.set(A_ID, 0.9);
          if (e.mdId === B_ID) m.set(B_ID, 0.9);
          if (e.mdId === C_ID) m.set(C_ID, 0.1);
        }
        return m;
      });
      await store.loadFromDisk();

      const result = await store.replace("memory", "A-stub-protected-replace-probe", grown);
      assert.ok(result.success, result.error);

      assert.deepEqual(result.evicted_md_ids, [C_ID], "lowest-heat OTHER (C) evicted; hotter OTHER (B) + protected (A) survive");
    } finally {
      await fx.cleanup();
    }
  });
});

// ===========================================================================
// 4 — DISABLE-PATH PARITY (decayEnabled === false → byte-identical FIFO)
// ===========================================================================

describe("decay eviction — disable-path parity (decayEnabled === false → FIFO)", () => {
  /** File order A, B, C with a heat Map that REORDERS (C coldest → heat evicts
    * C first; FIFO evicts A first). Same seed + same limit for every store so
    * the comparison is byte-fair. Uniform-length bodies so ONE limit forces the
    * same eviction COUNT whether FIFO or heat picks the victims. */
  async function seedTriplet(memoryDir: string): Promise<{ A: string; B: string; C: string }> {
    const A = fm(A_ID, body("A-oldest-disable-parity-probe-file-order-first"));
    const B = fm(B_ID, body("B-midfile-disable-parity-probe-second-on-disk"));
    const C = fm(C_ID, body("C-newest-disable-parity-probe-last-on-disk"));
    await seedMemory(memoryDir, [A, B, C]);
    return { A, B, C };
  }

  /** A fixed reordering heat Map (C coldest, A hottest) — wired ONLY when decay
    * is enabled, mirroring index.ts's `shouldWireHeat` gate. */
  function reorderingProvider(_t: string, entries: { mdId: string }[]): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const e of entries) {
      if (e.mdId === A_ID) m.set(A_ID, 0.9);
      if (e.mdId === B_ID) m.set(B_ID, 0.5);
      if (e.mdId === C_ID) m.set(C_ID, 0.1);
    }
    return Promise.resolve(m);
  }

  it("goal4: decayEnabled:false evicts BYTE-IDENTICALLY to a no-provider reference (FIFO parity)", async () => {
    const fxDisabled = await makeFixture();
    const fxRef = await makeFixture();
    try {
      const seed1 = await seedTriplet(fxDisabled.memoryDir);
      const seed2 = await seedTriplet(fxRef.memoryDir);
      const incoming = body("NEW-disable-parity-incoming-probe-overflow");
      // Uniform bodies → one limit forces exactly TWO evictions under either
      // mode (FIFO or heat). Survivors are one entry + incoming.
      const limit = joinLen([seed1.C, encodeTemplate(incoming)]);

      // DISABLED store: mirrors index.ts — shouldWireHeat(false) === false → the
      // provider is simply NOT attached (the first-class disable invariant).
      const disabled = makeStore(fxDisabled.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "vault-offload" });
      assert.equal(shouldWireHeat({ decayEnabled: false }), false, "gate: decayEnabled:false → provider NOT wired");
      // (no setHeatForEntriesProvider call — exactly what index.ts does)
      await disabled.loadFromDisk();

      // RAW reference: no provider, no decay config — the pre-#1b baseline.
      const reference = makeStore(fxRef.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "vault-offload" });
      await reference.loadFromDisk();

      const rDisabled = await disabled.add("memory", incoming);
      const rRef = await reference.add("memory", incoming);
      assert.ok(rDisabled.success && rRef.success);

      // Byte-identical: disabled-path eviction == no-provider reference == FIFO
      // (oldest file-position first: A then B; C — the file-newest — survives).
      assert.deepEqual(rDisabled.evicted_md_ids, rRef.evicted_md_ids, "disable path == no-provider reference (byte-identical)");
      assert.deepEqual(rDisabled.evicted_md_ids, [A_ID, B_ID], "FIFO fixture: oldest file-position first, newest survives");
    } finally {
      await fxDisabled.cleanup();
      await fxRef.cleanup();
    }
  });

  it("goal4: with decay ENABLED + a reordering provider, the order DIFFERS from FIFO (the gate is meaningful)", async () => {
    const fxDisabled = await makeFixture();
    const fxEnabled = await makeFixture();
    try {
      const seed1 = await seedTriplet(fxDisabled.memoryDir);
      await seedTriplet(fxEnabled.memoryDir);
      const incoming = body("NEW-enable-vs-disable-incoming-probe-overflow");
      const limit = joinLen([seed1.C, encodeTemplate(incoming)]);

      // DISABLED: no provider (gate off) → FIFO.
      const disabled = makeStore(fxDisabled.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "vault-offload" });
      await disabled.loadFromDisk();

      // ENABLED: gate on → reordering provider attached → heat order.
      const enabled = makeStore(fxEnabled.memoryDir, { memoryCharLimit: limit, memoryOverflowStrategy: "vault-offload" });
      assert.equal(shouldWireHeat({ decayEnabled: true }), true, "gate: decayEnabled:true (or unset) → provider wired");
      enabled.setHeatForEntriesProvider(reorderingProvider);
      await enabled.loadFromDisk();

      const rDisabled = await disabled.add("memory", incoming);
      const rEnabled = await enabled.add("memory", incoming);
      assert.ok(rDisabled.success && rEnabled.success);

      // The two orders DIFFER: FIFO evicts A first (file-order), heat evicts C
      // first (coldest). This proves the gate actually changes behavior — so the
      // byte-identical disable parity above is a real guarantee, not a vacuous
      // one (both modes would be identical if the provider did nothing).
      assert.deepEqual(rDisabled.evicted_md_ids, [A_ID, B_ID], "disabled → FIFO (oldest first)");
      assert.deepEqual(rEnabled.evicted_md_ids, [C_ID, B_ID], "enabled → heat-ascending (coldest first)");
      assert.notDeepEqual(rDisabled.evicted_md_ids, rEnabled.evicted_md_ids, "enable vs disable produce DIFFERENT orders");
    } finally {
      await fxDisabled.cleanup();
      await fxEnabled.cleanup();
    }
  });
});
