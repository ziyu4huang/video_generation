/**
 * PerfRecorder — lightweight, breach-only perf tracking for hermes-memory.
 *
 * Exercises: timed() transparency, AsyncLocalStorage round-trip attribution,
 * breach detection (ms + roundTrips thresholds), breach-only persistence
 * (fullTrace opt-in), and null-log safety.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPerfRecorder, bumpRoundTrips, type PerfRecord } from "../src/perf.js";

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), "hm-perf-")), "perf.jsonl");
}

function readLog(p: string): PerfRecord[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as PerfRecord);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("PerfRecorder", () => {
  it("timed() is transparent — returns the wrapped fn's result", async () => {
    const perf = createPerfRecorder({ logPath: null });
    const out = await perf.timed("op", async () => 42);
    expect(out).toBe(42);
  });

  it("attributes bumpRoundTrips to the active op via AsyncLocalStorage", async () => {
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, fullTrace: true, getBackend: () => "test" });
    await perf.timed("scan", async () => {
      bumpRoundTrips(5);
      await sleep(1);
      bumpRoundTrips(2);
    });
    const recs = readLog(log);
    expect(recs.length).toBe(1);
    expect(recs[0].op).toBe("scan");
    expect(recs[0].roundTrips).toBe(7);
    expect(recs[0].backend).toBe("test");
  });

  it("flags a round-trip breach and notifies (logged even without fullTrace)", async () => {
    const log = tmpLog();
    const breaches: PerfRecord[] = [];
    const perf = createPerfRecorder({
      logPath: log, thresholdRoundTrips: 3, thresholdMs: 999_999, getBackend: () => "test",
    });
    perf.setNotifier((r) => breaches.push(r));
    await perf.timed("n-plus-one", async () => { bumpRoundTrips(5); });
    const recs = readLog(log);
    expect(recs.length).toBe(1);
    expect(recs[0].breach).toBe(true);
    expect(recs[0].reason).toBe("roundTrips");
    expect(recs[0].roundTrips).toBe(5);
    expect(breaches.length).toBe(1);
    expect(breaches[0].op).toBe("n-plus-one");
  });

  it("flags a time breach (reason = ms)", async () => {
    const breaches: PerfRecord[] = [];
    const perf = createPerfRecorder({
      logPath: null, thresholdMs: 10, thresholdRoundTrips: 999_999,
    });
    perf.setNotifier((r) => breaches.push(r));
    await perf.timed("slow", async () => { await sleep(40); });
    expect(breaches.length).toBe(1);
    expect(breaches[0].breach).toBe(true);
    expect(breaches[0].reason).toBe("ms");
    expect(breaches[0].ms).toBeGreaterThanOrEqual(10);
  });

  it("does NOT persist a non-breaching op when fullTrace is off", async () => {
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, thresholdMs: 999_999, thresholdRoundTrips: 999_999 });
    await perf.timed("cheap", async () => { bumpRoundTrips(1); });
    expect(readLog(log).length).toBe(0);
  });

  it("persists every op when fullTrace is on", async () => {
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, fullTrace: true });
    await perf.timed("a", async () => {});
    await perf.timed("b", async () => { bumpRoundTrips(2); });
    const recs = readLog(log);
    expect(recs.length).toBe(2);
    expect(recs.map((r) => r.op)).toEqual(["a", "b"]);
    expect(recs[1].roundTrips).toBe(2);
  });

  it("survives a null logPath (no file, breach still notifies)", async () => {
    const breaches: PerfRecord[] = [];
    const perf = createPerfRecorder({ logPath: null, thresholdRoundTrips: 1 });
    perf.setNotifier((r) => breaches.push(r));
    await perf.timed("x", async () => { bumpRoundTrips(3); }); // no throw
    expect(breaches.length).toBe(1);
  });

  it("bumpRoundTrips outside any timed() is a safe no-op", async () => {
    expect(() => bumpRoundTrips(10)).not.toThrow();
  });

  // ─── timedAlways: always-persist path (T1) ───

  it("timedAlways() is transparent and persists a record on EVERY call, even under threshold", async () => {
    const log = tmpLog();
    // thresholds impossibly high → a breach is impossible; timedAlways must persist anyway
    const perf = createPerfRecorder({ logPath: log, thresholdMs: 999_999, thresholdRoundTrips: 999_999, getBackend: () => "test" });
    const out = await perf.timedAlways("event", async () => 7);
    expect(out).toBe(7); // transparency
    const recs = readLog(log);
    expect(recs.length).toBe(1);
    expect(recs[0].op).toBe("event");
    expect(recs[0].backend).toBe("test");
    expect(recs[0].breach).toBe(false); // an event, not a breach
    expect(recs[0].kind).toBeUndefined(); // not passed
    expect(recs[0].timedOut).toBeUndefined();
  });

  it("timedAlways() fires the notifier on every call (not only on breach)", async () => {
    const events: PerfRecord[] = [];
    const perf = createPerfRecorder({ logPath: null, thresholdMs: 999_999, thresholdRoundTrips: 999_999 });
    perf.setNotifier((r) => events.push(r));
    await perf.timedAlways("e1", async () => {});
    await perf.timedAlways("e2", async () => {});
    expect(events.length).toBe(2);
    expect(events.map((r) => r.op)).toEqual(["e1", "e2"]);
  });

  it("timedAlways() stamps kind and derives timedOut from the result via timedOutFrom", async () => {
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, getBackend: () => "test" });
    const out = await perf.timedAlways(
      "consolidation.failure",
      async () => ({ consolidated: true, timedOut: true }),
      { kind: "consolidation", timedOutFrom: (r: { timedOut: boolean }) => r.timedOut },
    );
    expect(out).toEqual({ consolidated: true, timedOut: true }); // transparency
    const recs = readLog(log);
    expect(recs.length).toBe(1);
    expect(recs[0].kind).toBe("consolidation");
    expect(recs[0].timedOut).toBe(true);
  });

  it("timedAlways() preserves the never-throws invariant (null logPath still notifies)", async () => {
    const events: PerfRecord[] = [];
    const perf = createPerfRecorder({ logPath: null });
    perf.setNotifier((r) => events.push(r));
    await perf.timedAlways("x", async () => {}); // no throw even with no file
    expect(events.length).toBe(1);
  });

  it("timedAlways() persists (without timedOut) when fn throws, and re-throws", async () => {
    const log = tmpLog();
    const perf = createPerfRecorder({ logPath: log, getBackend: () => "test" });
    await expect(
      perf.timedAlways("consolidation.failure", async () => { throw new Error("boom"); }, { kind: "consolidation", timedOutFrom: () => true }),
    ).rejects.toThrow("boom");
    const recs = readLog(log);
    expect(recs.length).toBe(1);
    expect(recs[0].kind).toBe("consolidation");
    expect(recs[0].timedOut).toBeUndefined(); // no result to derive from
  });
});
