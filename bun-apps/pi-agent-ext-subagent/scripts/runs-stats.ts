/**
 * runs-stats.ts — one-shot dispatch-ledger statistics for budget calibration.
 *
 * Parses the durable subagent run records (~/.pi/subagents/runs/*.json) and
 * emits status counts + per-status token medians plus a cohort split by
 * budget.source — the inputs the dispatch-budget-rebalance skill's procedure
 * step 1 calls for. The >=100-run re-measure gate (#1663) is checked against
 * these numbers, never intuition.
 *
 * Usage:
 *   bun scripts/runs-stats.ts [runs-dir]                    stats + cohort split
 *   bun scripts/runs-stats.ts [runs-dir] --snapshot [file]  append one history
 *                                                            row (print it); pair
 *                                                            with --note <text>
 *   bun scripts/runs-stats.ts --trend [file]                render history rows
 *                                                            + re-measure gate
 *   bun scripts/runs-stats.ts --seed-history [file]         idempotent seed rows
 *
 *   [runs-dir] defaults to ~/.pi/subagents/runs
 *   [file]    defaults to <pkg>/docs/budget-history.jsonl
 *
 * Exit 0 always (stats tool, not a gate).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Rec = {
  status?: string;
  usage?: { total?: number };
  turns?: { turnsUsed?: number };
  budget?: { source?: "explicit" | "envelope-recon" | "envelope-writer" | "tier" };
  history?: unknown[];
};
type CohortAgg = {
  n: number;
  done: number;
  turns: number;
  budget: number;
  timedout: number;
  tokens: number[];
  turnsVals: number[];
};
type HistoryRow = {
  date?: string;
  totalRuns?: number;
  cohorts?: Record<string, { n?: number; tokenMedian?: number | null }>;
};

const DEFAULT_HISTORY = join(import.meta.dir, "..", "docs", "budget-history.jsonl");

const med = (xs: number[]): number | null =>
  xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Turns used: prefers the abort path's authoritative TurnExhaustion, else
 *  projects from the persisted transcript (assistant-message count) — done
 *  runs never carried a turns block, and history IS the canonical record,
 *  so the projection covers done + legacy records alike. */
const turnsOf = (r: Rec): number | undefined => {
  if (typeof r.turns?.turnsUsed === "number") return r.turns.turnsUsed;
  if (Array.isArray(r.history)) {
    const n = r.history.filter((m) => (m as { role?: string }).role === "assistant").length;
    if (n > 0) return n;
  }
  return undefined;
};

// --- arg parsing: [runs-dir] positional; [file] optional after each flag ---
const args = process.argv.slice(2);
let dirArg: string | undefined;
let snapshotFile: string | undefined;
let trendFile: string | undefined;
let seedFile: string | undefined;
let doSnapshot = false;
let doTrend = false;
let doSeed = false;
let note: string | undefined;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === undefined) continue;
  if (a === "--snapshot" || a === "--trend" || a === "--seed-history") {
    const nxt = args[i + 1];
    let file: string | undefined;
    if (nxt !== undefined && !nxt.startsWith("--")) {
      file = nxt;
      i += 1;
    }
    if (a === "--snapshot") {
      doSnapshot = true;
      snapshotFile = file;
    } else if (a === "--trend") {
      doTrend = true;
      trendFile = file;
    } else {
      doSeed = true;
      seedFile = file;
    }
  } else if (a === "--note") {
    note = args[i + 1];
    i += 1;
  } else if (dirArg === undefined) {
    dirArg = a;
  }
}

const dir = dirArg ?? join(homedir(), ".pi", "subagents", "runs");

// --- run-record scan (legacy records simply lack the budget field) ---
const readRuns = (d: string): Rec[] => {
  const recs: Rec[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      recs.push(JSON.parse(readFileSync(join(d, f), "utf8")) as Rec);
    } catch {
      /* skip malformed */
    }
  }
  return recs;
};

const cohortsOf = (recs: Rec[]): Map<string, CohortAgg> => {
  const byCohort = new Map<string, CohortAgg>();
  for (const r of recs) {
    const c = r.budget?.source ?? "unknown";
    const b = byCohort.get(c) ?? { n: 0, done: 0, turns: 0, budget: 0, timedout: 0, tokens: [], turnsVals: [] };
    b.n += 1;
    if (r.status === "done") b.done += 1;
    if (r.status === "turns") b.turns += 1;
    if (r.status === "budget") b.budget += 1;
    if (r.status === "timedout") b.timedout += 1;
    if (typeof r.usage?.total === "number") b.tokens.push(r.usage.total);
    const tu = turnsOf(r);
    if (tu !== undefined) b.turnsVals.push(tu);
    byCohort.set(c, b);
  }
  return byCohort;
};

const readHistory = (file: string): HistoryRow[] => {
  const rows: HistoryRow[] = [];
  if (!existsSync(file)) return rows;
  for (const ln of readFileSync(file, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    try {
      rows.push(JSON.parse(ln) as HistoryRow);
    } catch {
      /* skip malformed */
    }
  }
  return rows;
};

const appendLine = (file: string, line: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${line}\n`);
};

// --- --seed-history: idempotent motivating-ledger rows (verbatim) ---
const SEED_ROWS = [
  '{"date":"2026-08-18T00:00:00.000Z","totalRuns":200,"seed":true,"note":"pre-rebalance baseline (motivating ledger): turns 31/200, tokens 23/200, timeout 6/200; done-median 71k > old recon 60k ceiling — starvation; records untagged (pre forward-fix)"}',
  '{"date":"2026-08-18T00:00:01.000Z","totalRuns":200,"seed":true,"note":"post-rebalance snapshot (#1663): 124 done / 64 turns / 12 budget / 0 timedout of 200"}',
  '{"date":"2026-08-18T00:00:02.000Z","totalRuns":200,"seed":true,"note":"runs-stats first run (#1668): done n=120 tokenMedian 21096, turns n=70 tokenMedian 84004 turnsMedian 5 — confounded by orchestrator-pinned micro-dispatches; motivates the cohort split"}',
];

if (doSeed) {
  const file = seedFile ?? DEFAULT_HISTORY;
  if (existsSync(file) && statSync(file).size > 0) {
    console.log("seed: skipped");
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${SEED_ROWS.join("\n")}\n`);
    for (const r of SEED_ROWS) console.log(r);
  }
}

if (doSnapshot) {
  const recs = readRuns(dir);
  const cohorts: Record<
    string,
    { n: number; done: number; turns: number; budget: number; timedout: number; tokenMedian: number | null }
  > = {};
  for (const [c, b] of cohortsOf(recs)) {
    cohorts[c] = {
      n: b.n,
      done: b.done,
      turns: b.turns,
      budget: b.budget,
      timedout: b.timedout,
      tokenMedian: med(b.tokens),
    };
  }
  const line = JSON.stringify({
    date: new Date().toISOString(),
    totalRuns: recs.length,
    cohorts,
    ...(note !== undefined ? { note } : {}),
  });
  appendLine(snapshotFile ?? DEFAULT_HISTORY, line);
  console.log(line);
}

if (doTrend) {
  const rows = readHistory(trendFile ?? DEFAULT_HISTORY);
  let lastDelta = 0;
  rows.forEach((r, i) => {
    const total = Number(r.totalRuns ?? 0) || 0;
    // First row (or a single-row history) is a delta vs 0 = its own totalRuns.
    const prev = i === 0 ? 0 : Number(rows[i - 1]?.totalRuns ?? 0) || 0;
    const delta = total - prev;
    lastDelta = delta;
    const cohorts = r.cohorts
      ? Object.entries(r.cohorts)
          .map(([k, c]) => `${k} n=${c.n ?? 0} tokenMedian=${c.tokenMedian ?? "-"}`)
          .join(", ")
      : "-";
    console.log(`${r.date ?? "-"} | total=${total} | runsSinceLast=${delta} | cohorts: ${cohorts}`);
  });
  if (lastDelta >= 100) console.log(`GATE: ${lastDelta} runs since last snapshot — ARMED`);
  else console.log(`GATE: NOT ARMED (need ${100 - lastDelta} more)`);
}

// --- default: status counts + per-status medians + cohort split (exit 0) ---
if (!doSeed && !doSnapshot && !doTrend) {
  const recs = readRuns(dir);
  const byStatus = new Map<string, { n: number; tokens: number[]; turns: number[] }>();
  for (const r of recs) {
    const s = r.status ?? "unknown";
    const b = byStatus.get(s) ?? { n: 0, tokens: [], turns: [] };
    b.n += 1;
    if (typeof r.usage?.total === "number") b.tokens.push(r.usage.total);
    const tu = turnsOf(r);
    if (tu !== undefined) b.turns.push(tu);
    byStatus.set(s, b);
  }

  console.log(`runs-dir: ${dir}`);
  console.log(`total: ${recs.length}`);
  for (const [s, b] of [...byStatus.entries()].sort((a, c) => c[1].n - a[1].n)) {
    const t = med(b.tokens);
    const u = med(b.turns);
    console.log(`${s}: n=${b.n} tokenMedian=${t ?? "-"} turnsMedian=${u ?? "-"}`);
  }

  for (const [c, b] of [...cohortsOf(recs).entries()].sort((a, x) => x[1].n - a[1].n)) {
    console.log(
      `cohort ${c}: n=${b.n} done=${b.done} turns=${b.turns} budget=${b.budget} tokenMedian=${med(b.tokens) ?? "-"} turnsMedian=${med(b.turnsVals) ?? "-"}`,
    );
  }
}
