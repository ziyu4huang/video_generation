/**
 * Lightweight perf tracking for hermes-memory.
 *
 * WHY: the extension had NO persistent perf signal. Several severe N+1
 * regressions (message UPSERTs #894, shutdown indexSession #903, backfill
 * session_files meta #906) were found only by manual measurement. This module
 * makes them auto-visible: each instrumented lifecycle operation is timed and
 * its HTTP round-trip count attributed (via AsyncLocalStorage) to the active
 * op; when an op crosses a threshold it is persisted to perf.jsonl and a
 * notifier fires (wired to the TUI by index.ts). Breach-only by default so
 * normal operation is zero-noise / zero-steady-state I/O; PI_HERMES_PERF=1
 * traces every op for deep profiling.
 *
 * DESIGN NOTES
 *  - `bumpRoundTrips` is a free module export: SurrealClient.query calls it
 *    once per round-trip. It is a no-op when no `timed()` is in scope, so
 *    instrumenting the client has zero cost for ad-hoc / test queries.
 *  - Nesting: `timed` uses AsyncLocalStorage.run, so a nested `timed` shadows
 *    its parent's counter (the parent undercounts for the nested span). The
 *    instrumented ops are deliberately top-level lifecycle calls that do not
 *    nest, so this is a non-issue in practice.
 *  - The recorder never throws into the instrumented path (append + notify are
 *    best-effort): perf tracking must not change functional behavior.
 *  - `timedAlways` is the ONE intentional exception to breach-only: it persists
 *    + notifies on every call (not threshold-gated), reserved for rare,
 *    high-signal events under active study (e.g. consolidation). The optional
 *    `kind` / `timedOut` record fields discriminate + annotate without touching
 *    legacy lifecycle records.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface PerfRecord {
  ts: string;
  op: string;
  backend: string;
  ms: number;
  roundTrips: number;
  breach: boolean;
  reason?: "ms" | "roundTrips";
  /** Path discriminator for log slicing. lifecycle = the #908 ops; fileLock /
   *  consolidation = the lock-path instrumentation. Omitted on legacy records. */
  kind?: "lifecycle" | "fileLock" | "consolidation";
  /** For consolidation records: whether the child sub-agent was terminated
   *  (the 60s cap). Derived post-call via timedAlways's timedOutFrom. */
  timedOut?: boolean;
  /** Optional caller-derived payload (e.g. consolidation applied/skipped op
   *  counts). Populated via timedAlways's extraFrom; never threshold-gated. */
  extra?: Record<string, unknown>;
}

interface PerfCtx {
  roundTrips: number;
}

/** Wrap an async operation for perf timing + round-trip attribution. Handlers
 *  accept this as an optional injectable (default pass-through) so the
 *  production recorder from index.ts can instrument them without coupling. */
export type TimedFn = <T>(op: string, fn: () => Promise<T>, opts?: { thresholdMs?: number; kind?: PerfRecord["kind"] }) => Promise<T>;

/** Always-persist counterpart of TimedFn: times + notifies on EVERY call (not
 *  threshold-gated). `kind` stamps the discriminator; `timedOutFrom` derives the
 *  timedOut flag from fn's result (only on success); `extraFrom` derives an
 *  optional caller payload (e.g. consolidation applied/skipped counts) stamped
 *  onto the record under `extra`. */
export type TimedAlwaysFn = <T>(
  op: string,
  fn: () => Promise<T>,
  opts?: {
    kind?: PerfRecord["kind"];
    timedOutFrom?: (result: T) => boolean;
    extraFrom?: (result: T) => Record<string, unknown>;
  },
) => Promise<T>;

export interface PerfRecorderOptions {
  /** Per-op wall-clock threshold (ms). Default 2000. */
  thresholdMs?: number;
  /** Per-op HTTP round-trip threshold. Default 50 — the primary N+1 signal. */
  thresholdRoundTrips?: number;
  /** JSONL append path. `null` disables file persistence. Default
   *  ~/.pi/agent/pi-hermes-memory/perf.jsonl. */
  logPath?: string | null;
  /** Trace EVERY op (not just breaches). Default: process.env.PI_HERMES_PERF === "1". */
  fullTrace?: boolean;
  /** Active-backend label stamped on each record. */
  getBackend?: () => string;
}

const als = new AsyncLocalStorage<PerfCtx>();

const DEFAULT_LOG_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-hermes-memory", "perf.jsonl",
);

/**
 * Increment the active operation's HTTP round-trip counter. Safe to call from
 * anywhere; a no-op when no `timed()` operation is in scope (ad-hoc / test
 * queries). Called once per SurrealClient.query.
 */
export function bumpRoundTrips(n = 1): void {
  const ctx = als.getStore();
  if (ctx) ctx.roundTrips += n;
}

export interface PerfRecorder {
  /** Wrap an async operation: time it, attribute round-trips, and on threshold
   *  breach (or when fullTrace is on) persist + notify. Returns fn's result. */
  timed: <T>(op: string, fn: () => Promise<T>, opts?: { thresholdMs?: number; kind?: PerfRecord["kind"] }) => Promise<T>;
  /** Always-persist variant: times + notifies on EVERY call, not threshold-gated.
   *  The ONE intentional exception to breach-only — reserved for rare,
   *  high-signal events under active study (e.g. consolidation). `kind` stamps
   *  the path discriminator; `timedOutFrom` (called with fn's result only on
   *  success) derives the timedOut flag. */
  timedAlways: TimedAlwaysFn;
  /** Override the breach notifier (default: console.warn). index.ts wires this
   *  to the TUI once a session provides a ui handle. */
  setNotifier: (fn: (record: PerfRecord) => void) => void;
}

export function createPerfRecorder(opts: PerfRecorderOptions = {}): PerfRecorder {
  const thresholdMs = opts.thresholdMs ?? 2000;
  const thresholdRt = opts.thresholdRoundTrips ?? 50;
  const logPath = opts.logPath === undefined ? DEFAULT_LOG_PATH : opts.logPath;
  const fullTrace = opts.fullTrace ?? process.env.PI_HERMES_PERF === "1";
  const getBackend = opts.getBackend ?? (() => "unknown");

  let notifier: (record: PerfRecord) => void = (r) => {
    const why = r.reason === "roundTrips"
      ? `${r.roundTrips} HTTP round-trips`
      : `${r.ms}ms`;
    const label = r.breach ? "slow" : "event";
    const line = `[hermes-memory] ${label} ${r.op}: ${why} (backend=${r.backend}). See perf.jsonl.`;
    // Consolidation is an expected, always-logged event — info, not an alarming warn.
    if (r.kind === "consolidation") console.info(line);
    else console.warn(line);
  };

  function appendLog(record: PerfRecord): void {
    if (!logPath) return;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      // perf tracking must never throw into the instrumented path
    }
  }

  async function timed<T>(op: string, fn: () => Promise<T>, opts?: { thresholdMs?: number; kind?: PerfRecord["kind"] }): Promise<T> {
    const ctx: PerfCtx = { roundTrips:0 };
    const start = Date.now();
    try {
      return await als.run(ctx, fn);
    } finally {
      const ms = Date.now() - start;
      const roundTrips = ctx.roundTrips;
      const effThresholdMs = opts?.thresholdMs ?? thresholdMs;
      const msBreach = ms > effThresholdMs;
      const rtBreach = roundTrips > thresholdRt;
      const breach = msBreach || rtBreach;
      if (breach || fullTrace) {
        const record: PerfRecord = {
          ts: new Date().toISOString(),
          op,
          backend: getBackend(),
          ms,
          roundTrips,
          breach,
          reason: msBreach ? "ms" : rtBreach ? "roundTrips" : undefined,
          kind: opts?.kind,
        };
        appendLog(record);
        if (breach) {
          try { notifier(record); } catch { /* never throw */ }
        }
      }
    }
  }

  /** Always-persist counterpart to `timed`: same timing + notifier, but records
   *  on every call (breach: false) regardless of thresholds. See interface. */
  async function timedAlways<T>(
    op: string,
    fn: () => Promise<T>,
    opts?: {
      kind?: PerfRecord["kind"];
      timedOutFrom?: (result: T) => boolean;
      extraFrom?: (result: T) => Record<string, unknown>;
    },
  ): Promise<T> {
    const ctx: PerfCtx = { roundTrips: 0 };
    const start = Date.now();
    let result: T | undefined;
    let succeeded = false;
    try {
      result = await als.run(ctx, fn);
      succeeded = true;
      return result;
    } finally {
      const ms = Date.now() - start;
      let timedOut: boolean | undefined;
      let extra: Record<string, unknown> | undefined;
      // Derive timedOut / extra only when fn succeeded — no result to read on throw.
      if (succeeded) {
        if (opts?.timedOutFrom) {
          try { timedOut = !!opts.timedOutFrom(result as T); } catch { /* never throw */ }
        }
        if (opts?.extraFrom) {
          try { extra = opts.extraFrom(result as T); } catch { /* never throw */ }
        }
      }
      const record: PerfRecord = {
        ts: new Date().toISOString(),
        op,
        backend: getBackend(),
        ms,
        roundTrips: ctx.roundTrips,
        breach: false,
        kind: opts?.kind,
        timedOut,
        extra,
      };
      appendLog(record);
      try { notifier(record); } catch { /* never throw into the instrumented path */ }
    }
  }

  return {
    timed,
    timedAlways,
    setNotifier: (fn) => { notifier = fn; },
  };
}
