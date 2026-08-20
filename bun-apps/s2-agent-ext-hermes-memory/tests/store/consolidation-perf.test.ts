/**
 * T3 — Consolidation always-logged event.
 *
 * Exercises the REAL overflow → runConsolidator path through _add, with a mock
 * consolidator (no real LLM). Verifies every consolidation is logged
 * (always-persist, the deliberate breach-only exception) with kind:consolidation
 * and the timedOut flag derived from the child's terminated result.
 *
 * The "both records present on a slow hold" assertion lives in ticket 04
 * (the controlled characterization sample); this file stays focused on the
 * consolidation event itself.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "bun:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
} from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";
import { createPerfRecorder, type PerfRecord } from "../../src/perf.js";

const TEST_MARKER = "[CONSOLIDATION-PERF-TEST]";
let MEMORY_DIR = "";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: MEMORY_DIR,
    ...overrides,
  };
}

function tmpLog(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hm-cons-")), "perf.jsonl");
}

function readLog(p: string): PerfRecord[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as PerfRecord);
}

describe("MemoryStore consolidation perf (T3)", { concurrency: 1 }, () => {
  beforeAll(async () => {
    MEMORY_DIR = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cons-perf-test-"));
  });
  afterAll(async () => {
    try { await fs.promises.rm(MEMORY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("logs every consolidation as consolidation.<target> (always-logged, kind, breach:false)", async () => {
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, getBackend: () => "test" });
    // Tiny limit + auto-consolidate so a modest add overflows into runConsolidator.
    const store = new MemoryStore(makeConfig({ memoryCharLimit: 50, autoConsolidate: true }));
    await store.loadFromDisk();
    store.setConsolidator(async (snapshot) => ({ plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } })); // fast mock — still must be logged
    store.setPerfAlways(perf.timedAlways);
    await store.add("memory", `${TEST_MARKER} ${"x".repeat(100)}`);

    const cons = readLog(log).filter((r) => r.op === "consolidation.memory");
    assert.ok(cons.length >= 1, "a consolidation record was produced");
    assert.equal(cons[0].kind, "consolidation");
    assert.equal(cons[0].breach, false); // an event, not a breach
    assert.equal(cons[0].timedOut, false); // mock did not terminate
    // 2-phase payload: the plan's applied/skipped op counts are stamped on the
    // record under `extra` (a no-op plan applies nothing here).
    assert.deepEqual(cons[0].extra, { applied: 0, skipped: 0 },
      "extra payload stamps the plan's applied/skipped op counts");
  });

  it("stamps timedOut:true when the consolidator child was terminated", async () => {
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, getBackend: () => "test" });
    const store = new MemoryStore(makeConfig({ memoryCharLimit: 50, autoConsolidate: true }));
    await store.loadFromDisk();
    // Mock a terminated child (the 60s cap) — consolidation fails + terminated flag set.
    store.setConsolidator(async () => ({ error: "terminated", terminated: true }));
    store.setPerfAlways(perf.timedAlways);
    await store.add("memory", `${TEST_MARKER} ${"y".repeat(100)}`);

    const cons = readLog(log).filter((r) => r.op === "consolidation.memory");
    assert.ok(cons.length >= 1);
    assert.equal(cons[0].timedOut, true);
  });
});
