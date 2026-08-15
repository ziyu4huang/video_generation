/**
 * Pathology detector (F v1) — PURE.
 *
 * analyzePathology(input) runs the three deterministic, signal-driven detectors
 * (retry loop, tool error storm, context saturation) over a typed call-log and
 * returns Finding[] using the same Severity framework as inspect_extensions.
 *
 * No SDK, no fs, no accumulator — fully unit-testable. The tool wrapper
 * (makeInspectPathologyTool) and the hook-fed ring buffer (accumulator.ts) feed
 * this function with live data; nothing here reads live state.
 *
 * Circular-import note: only the `Finding` *type* is imported from the package
 * entry — a type-only import that is erased at compile time, so there is no
 * runtime dependency on src/index.ts.
 */
import type { Finding } from "../findings.ts";
import type { PathologyInput, ToolCallRecord } from "./types.ts";

// ─── defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  loopRepeatThreshold: 3,
  loopWindowSize: 30,
  errorRateThreshold: 0.5,
  errorRateMinCalls: 4,
  consecutiveErrorThreshold: 3,
  saturationPercent: 85,
  longSessionTurnThreshold: 15,
} as const;

/** The threshold subset of PathologyInput, fully resolved with defaults. */
interface ResolvedOpts {
  loopRepeatThreshold: number;
  loopWindowSize: number;
  errorRateThreshold: number;
  errorRateMinCalls: number;
  consecutiveErrorThreshold: number;
  saturationPercent: number;
  longSessionTurnThreshold: number;
}

/** Hard cap on an args signature's length — keeps loop keys cheap to compare. */
const MAX_SIG = 200;

// ─── argsSig ─────────────────────────────────────────────────────────────────

/**
 * Recursively sort object keys so {a:1,b:2} and {b:2,a:1} serialize identically.
 * Arrays preserve order (position is meaningful), objects get sorted keys.
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize(o[k]);
        return acc;
      }, {});
  }
  return v;
}

/**
 * FNV-1a 32-bit hash (pure, dependency-free). Used only to disambiguate
 * truncated arg signatures so distinct long args never collide — NOT
 * cryptographic; collision resistance over a session-sized call set is plenty.
 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Build a stable, order-independent, length-bounded signature for a tool call's
 * arguments. Two calls with the same args (any key order) produce the same sig;
 * undefined and null are distinct sentinels. Used both by the accumulator and by
 * the retry-loop detector to match "identical" calls.
 *
 * Truncation is collision-resistant: when the canonical JSON exceeds MAX_SIG,
 * a short readable head is kept for display but a hash + length of the FULL
 * content disambiguates it. Head-only truncation would collapse any commands
 * sharing a >MAX_SIG prefix (a shell-function preamble, a long path — a common
 * benign pattern) to one signature and false-trip the consecutive-run detector
 * (the recurring "⚠ retry loop: bash ×3" status bar).
 */
export function argsSig(args: unknown): string {
  if (args === undefined) return "∅";
  if (args === null) return "null";
  const json = JSON.stringify(canonicalize(args));
  if (json.length <= MAX_SIG) return json;
  return json.slice(0, MAX_SIG - 18) + `…[${json.length}:#${fnv1a32(json)}]`;
}

// ─── detectors ───────────────────────────────────────────────────────────────

/** 🔴 retry loop — identical (tool+args) repeated CONSECUTIVELY (a back-to-back run).
 *  A count-in-window detector false-positives on benign repetition — e.g. `git
 *  status` run 3× interleaved with other work looks like a loop under a plain
 *  window count, producing a permanent "⚠ retry loop: bash ×3" status bar in
 *  any busy session. A tight CONSECUTIVE run is the actual pathology signal:
 *  the agent re-running the identical command back-to-back without updating its
 *  strategy. Spread-out repetition is benign. */
function detectRetryLoop(calls: ToolCallRecord[], opts: ResolvedOpts): Finding[] {
  const window = calls.slice(-opts.loopWindowSize);
  // Track the longest back-to-back run of identical (tool+args) signatures.
  const maxRun = new Map<string, number>();
  const meta = new Map<string, { tool: string; sig: string }>();
  let curKey: string | null = null;
  let curRun = 0;
  for (const c of window) {
    const key = c.toolName + "\0" + c.argsSig;
    if (key === curKey) {
      curRun += 1;
    } else {
      curKey = key;
      curRun = 1;
      meta.set(key, { tool: c.toolName, sig: c.argsSig });
    }
    maxRun.set(key, Math.max(maxRun.get(key) ?? 0, curRun));
  }
  const findings: Finding[] = [];
  for (const [key, run] of maxRun) {
    if (run >= opts.loopRepeatThreshold) {
      const { tool, sig } = meta.get(key)!;
      findings.push({
        severity: "high",
        check: "retry-loop",
        message: `Tool "${tool}" called ${run}× consecutively with identical args — likely a retry loop`,
        detail: { tool, argsPreview: sig.slice(0, 80), count: run, window: window.length },
      });
    }
  }
  return findings;
}

/** 🔴 consecutive errors — a tool failing N times in a row (rage-quit). */
function detectConsecutiveErrors(calls: ToolCallRecord[], opts: ResolvedOpts): Finding[] {
  const findings: Finding[] = [];
  // longest run of consecutive errors, per tool (over the tool's own call subsequence)
  const maxRun = new Map<string, number>();
  const curRun = new Map<string, number>();
  for (const c of calls) {
    const r = c.isError ? (curRun.get(c.toolName) ?? 0) + 1 : 0;
    curRun.set(c.toolName, r);
    maxRun.set(c.toolName, Math.max(maxRun.get(c.toolName) ?? 0, r));
  }
  for (const [tool, run] of maxRun) {
    if (run >= opts.consecutiveErrorThreshold) {
      findings.push({
        severity: "high",
        check: "consecutive-error",
        message: `Tool "${tool}" failed ${run}× consecutively — repeated identical failure, strategy not updated`,
        detail: { tool, consecutive: run },
      });
    }
  }
  return findings;
}

/** 🟡 tool error storm — a tool whose error rate crosses the threshold. */
function detectErrorStorm(calls: ToolCallRecord[], opts: ResolvedOpts): Finding[] {
  const stats = new Map<string, { calls: number; errors: number }>();
  for (const c of calls) {
    const e = stats.get(c.toolName) ?? { calls: 0, errors: 0 };
    e.calls += 1;
    if (c.isError) e.errors += 1;
    stats.set(c.toolName, e);
  }
  const findings: Finding[] = [];
  for (const [tool, { calls: n, errors }] of stats) {
    if (n >= opts.errorRateMinCalls) {
      const rate = errors / n;
      if (rate >= opts.errorRateThreshold) {
        findings.push({
          severity: "medium",
          check: "error-storm",
          message: `Tool "${tool}" error rate ${(rate * 100).toFixed(0)}% (${errors}/${n} calls) — chronic failure`,
          detail: { tool, errors, calls: n, rate: Math.round(rate * 1000) / 1000 },
        });
      }
    }
  }
  return findings;
}

/** 🟡 context saturation — context window filling up (recall/quality risk). */
function detectSaturation(contextPercent: number | null, opts: ResolvedOpts): Finding[] {
  if (contextPercent == null || contextPercent < opts.saturationPercent) return [];
  return [
    {
      severity: "medium",
      check: "context-saturation",
      message: `Context window ${contextPercent.toFixed(1)}% full — risk of context loss / recall degradation in long sessions`,
      detail: { percent: contextPercent },
    },
  ];
}

/** 🟡 long-session recall risk — many completed turns → context-loss / goal-drift risk.
 *  Deterministic proxy (studies show a 15–30% recall drop beyond ~10 turns). The
 *  true LLM-judged goal-drift / silent-degradation modes need a runtime model call,
 *  which this repo's --offline (zero-egress) discipline rules out for a diagnostic —
 *  so v2 ships this deterministic hint; exact judgment remains a future step. */
function detectLongSession(turnCount: number | null, opts: ResolvedOpts): Finding[] {
  if (turnCount == null || turnCount < opts.longSessionTurnThreshold) return [];
  return [
    {
      severity: "medium",
      check: "long-session-recall-risk",
      message: `${turnCount} turns completed — long sessions show ~15–30% recall drop; consider re-stating key constraints`,
      detail: { turnCount },
    },
  ];
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * Run all v1 pathology detectors against a fully-derived input. PURE.
 *
 * Finding order: retry-loop (high), consecutive-error (high), error-storm
 * (medium), context-saturation (medium), then a single info session-stats
 * summary. Callers format via formatPathologyReport().
 */
export function analyzePathology(raw: PathologyInput): Finding[] {
  const opts = {
    loopRepeatThreshold: raw.loopRepeatThreshold ?? DEFAULTS.loopRepeatThreshold,
    loopWindowSize: raw.loopWindowSize ?? DEFAULTS.loopWindowSize,
    errorRateThreshold: raw.errorRateThreshold ?? DEFAULTS.errorRateThreshold,
    errorRateMinCalls: raw.errorRateMinCalls ?? DEFAULTS.errorRateMinCalls,
    consecutiveErrorThreshold: raw.consecutiveErrorThreshold ?? DEFAULTS.consecutiveErrorThreshold,
    saturationPercent: raw.saturationPercent ?? DEFAULTS.saturationPercent,
    longSessionTurnThreshold: raw.longSessionTurnThreshold ?? DEFAULTS.longSessionTurnThreshold,
  };

  const calls = raw.calls;
  const findings: Finding[] = [
    ...detectRetryLoop(calls, opts),
    ...detectConsecutiveErrors(calls, opts),
    ...detectErrorStorm(calls, opts),
    ...detectSaturation(raw.contextPercent, opts),
    ...detectLongSession(raw.turnCount ?? null, opts),
  ];

  // ℹ️ session stats — awareness only, never counted as actionable.
  const totalErrors = calls.filter((c) => c.isError).length;
  const distinctTools = new Set(calls.map((c) => c.toolName)).size;
  findings.push({
    severity: "info",
    check: "session-stats",
    message: `${calls.length} tool call(s) across ${distinctTools} tool(s); ${totalErrors} error(s); context ${raw.contextPercent?.toFixed(1) ?? "?"}%`,
    detail: { calls: calls.length, distinctTools, errors: totalErrors, contextPercent: raw.contextPercent },
  });

  return findings;
}
