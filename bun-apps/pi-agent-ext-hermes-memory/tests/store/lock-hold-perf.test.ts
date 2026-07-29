/**
 * T2 — Lock-hold breach timing via store DI.
 *
 * Determinism: writes go to a per-test tmpdir (mkdtemp under os.tmpdir()), never
 * the real ~/.pi/agent/memory/. The lock-hold span exercised here is the REAL
 * cross-process lock (proper-lockfile) on that tmpdir, the same path production
 * takes — we only swap in a spy/real PerfRecorder via setPerfTimed.
 *
 * Honest scope: these tests prove the held span is wrapped + breaches at the
 * lock threshold. They do NOT measure real cross-process ELOCKED counts (that
 * needs live multi-session data; see ticket 04).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
} from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";
import {
  createPerfRecorder,
  type PerfRecord,
  type TimedFn,
} from "../../src/perf.js";

const TEST_MARKER = "[LOCK-HOLD-PERF-TEST]";
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hm-lock-")), "perf.jsonl");
}

function readLog(p: string): PerfRecord[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as PerfRecord);
}

describe("MemoryStore lock-hold perf (T2)", { concurrency: 1 }, () => {
  beforeAll(async () => {
    MEMORY_DIR = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-lock-hold-test-"));
  });
  afterAll(async () => {
    try { await fs.promises.rm(MEMORY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  beforeEach(async () => {
    try { await fs.promises.rm(path.join(MEMORY_DIR, "MEMORY.md"), { force: true }); } catch { /* ignore */ }
    // Defensive: clear a residual proper-lockfile lock dir a prior test may have
    // left, so a stale lock can't ELOCKED this test's acquisition + cascade.
    try { await fs.promises.rm(path.join(MEMORY_DIR, "MEMORY.md.lock"), { recursive: true, force: true }); } catch { /* ignore */ }
  });
  afterEach(() => {
    delete process.env.PI_HERMES_PERF_LOCK_MS;
  });

  it("add() works with no recorder injected (pass-through default, no behavior change)", async () => {
    const store = new MemoryStore(makeConfig());
    await store.loadFromDisk();
    const res = await store.add("memory", `${TEST_MARKER} no-recorder`);
    assert.ok(res.success);
  });

  it("wraps the held span as fileLock.hold.<target> with the lock threshold", async () => {
    const calls: Array<{ op: string; thresholdMs?: number; kind?: string }> = [];
    const spy: TimedFn = (op, fn, opts) => {
      calls.push({ op, thresholdMs: opts?.thresholdMs, kind: opts?.kind });
      return fn();
    };
    const store = new MemoryStore(makeConfig());
    await store.loadFromDisk();
    store.setPerfTimed(spy);
    await store.add("memory", `${TEST_MARKER} spy-probe`);
    const holdCall = calls.find((c) => c.op === "fileLock.hold.memory");
    assert.ok(holdCall, "fileLock.hold.memory was timed");
    assert.equal(holdCall!.thresholdMs, 5000); // default lock threshold
    assert.equal(holdCall!.kind, "fileLock");
  });

  it("breaches when the held span exceeds the lock threshold", async () => {
    process.env.PI_HERMES_PERF_LOCK_MS = "5"; // 5ms threshold
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, getBackend: () => "test" });
    const store = new MemoryStore(makeConfig());
    await store.loadFromDisk();
    // Simulate a slow held span (e.g. a consolidation-scale hold) by sleeping
    // INSIDE the measured critical section, so the breach is deterministic.
    const slowTimed: TimedFn = (op, fn, opts) =>
      perf.timed(op, async () => { await new Promise((r) => setTimeout(r, 30)); return fn(); }, opts);
    store.setPerfTimed(slowTimed);
    await store.add("memory", `${TEST_MARKER} breach-probe`);
    const holds = readLog(log).filter((r) => r.op === "fileLock.hold.memory");
    assert.ok(holds.length >= 1, "a lock-hold record was produced");
    assert.equal(holds[0].breach, true);
    assert.equal(holds[0].reason, "ms");
    assert.equal(holds[0].kind, "fileLock");
  });

  it("produces NO lock-path record for a normal fast write (breach-only)", async () => {
    // default lock threshold 5000ms — a fast file write stays well under it
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log });
    const store = new MemoryStore(makeConfig());
    await store.loadFromDisk();
    store.setPerfTimed(perf.timed);
    await store.add("memory", `${TEST_MARKER} fast-probe`);
    const holds = readLog(log).filter((r) => r.op.startsWith("fileLock.hold."));
    assert.equal(holds.length, 0);
  });

  it("never-throws: a notifier failure during a real breach does not break the write", async () => {
    process.env.PI_HERMES_PERF_LOCK_MS = "5";
    const perf = createPerfRecorder({ logPath: null }); // null log → only the notifier path fires
    perf.setNotifier(() => { throw new Error("notifier boom"); });
    const store = new MemoryStore(makeConfig());
    await store.loadFromDisk();
    // Force a REAL breach (slow span) so the notifier actually fires + throws.
    const slowTimed: TimedFn = (op, fn, opts) =>
      perf.timed(op, async () => { await new Promise((r) => setTimeout(r, 30)); return fn(); }, opts);
    store.setPerfTimed(slowTimed);
    const res = await store.add("memory", `${TEST_MARKER} notifier-throw-probe`);
    assert.ok(res.success, "write succeeded despite a throwing notifier during breach");
  });
});
