/**
 * T4 — Controlled characterization sample (the D3 deliverable).
 *
 * Proves T2 (lock-hold breach timing) + T3 (consolidation always-logged event)
 * work together end-to-end through the REAL overflow → consolidation → lock-hold
 * path in _add, with NO real LLM, NO real Surreal, NO real multi-process
 * concurrency: a tiny Failure char limit forces overflow, a mock consolidator
 * that sleeps simulates the local-LLM hold, and a real PerfRecorder (low lock
 * threshold + tmp logPath) captures both record kinds.
 *
 * HONEST SCOPE: this characterizes *hold duration + timeout frequency* — the
 * core #853 signal. It does NOT measure real cross-process ELOCKED counts or
 * real contention across live sessions; that data accumulates passively from
 * real usage AFTER the instrumentation ships. The synthetic sample here must
 * never be mistaken for real contention telemetry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll, afterEach } from "bun:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
} from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";
import { createPerfRecorder, type PerfRecord } from "../../src/perf.js";

const TEST_MARKER = "[CHARACTERIZATION-TEST]";
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hm-char-")), "perf.jsonl");
}

function readLog(p: string): PerfRecord[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as PerfRecord);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("MemoryStore controlled characterization sample (T4)", { concurrency: 1 }, () => {
  beforeAll(async () => {
    MEMORY_DIR = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-characterization-test-"));
  });
  afterAll(async () => {
    try { await fs.promises.rm(MEMORY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  afterEach(() => {
    delete process.env.PI_HERMES_PERF_LOCK_MS;
  });

  it("a slow 2-phase consolidation logs the LLM hold on consolidation.<target>, NOT on fileLock.hold (lock released during step 2)", async () => {
    process.env.PI_HERMES_PERF_LOCK_MS = "5";
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, getBackend: () => "test" });
    // Tiny Failure limit + auto-consolidate → a modest addFailure overflows into
    // runConsolidator. Step 2 (the LLM) runs lock-free; step 3 is a brief
    // locked reconcile.
    const store = new MemoryStore(makeConfig({ failureCharLimit: 50, autoConsolidate: true }));
    await store.loadFromDisk();
    // Slow mock consolidator simulates the local-LLM hold (the #853 signal).
    store.setConsolidator(async (snapshot) => { await sleep(50); return { plan: { snapshotBaseHash: snapshot.snapshotBaseHash, ops: [] } }; });
    store.setPerfTimed(perf.timed);
    store.setPerfAlways(perf.timedAlways);
    await store.addFailure(`${TEST_MARKER} ${"z".repeat(80)}`, { category: "failure" });

    const recs = readLog(log);
    const cons = recs.filter((r) => r.op === "consolidation.failure");
    const holds = recs.filter((r) => r.op === "fileLock.hold.failure");
    assert.ok(cons.length >= 1, "consolidation.failure event was logged");
    assert.equal(cons[0].kind, "consolidation");
    assert.equal(cons[0].breach, false);
    // The LLM hold (≥40ms of the 50ms sleep) is timed on the consolidation
    // event, NOT on a fileLock.hold breach (the lock is released during step 2).
    assert.ok(cons[0].ms >= 40, `consolidation ms should capture the LLM hold; got ${cons[0].ms}`);
    const maxHoldMs = holds.length ? Math.max(...holds.map((r) => r.ms)) : 0;
    assert.ok(maxHoldMs < cons[0].ms,
      `the file lock must NOT be held for the LLM duration (max hold ${maxHoldMs}ms vs consolidation ${cons[0].ms}ms); no lock-hold breach during step 2`);
  });

  it("a terminating slow consolidation stamps timedOut:true on the consolidation record", async () => {
    process.env.PI_HERMES_PERF_LOCK_MS = "5";
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, getBackend: () => "test" });
    const store = new MemoryStore(makeConfig({ failureCharLimit: 50, autoConsolidate: true }));
    await store.loadFromDisk();
    store.setConsolidator(async () => { await sleep(50); return { error: "terminated", terminated: true }; });
    store.setPerfTimed(perf.timed);
    store.setPerfAlways(perf.timedAlways);
    await store.addFailure(`${TEST_MARKER} ${"w".repeat(80)}`, { category: "failure" });

    const cons = readLog(log).filter((r) => r.op === "consolidation.failure");
    assert.ok(cons.length >= 1);
    assert.equal(cons[0].timedOut, true);
  });
});
