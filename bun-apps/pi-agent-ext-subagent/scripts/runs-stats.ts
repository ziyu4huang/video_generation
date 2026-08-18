/**
 * runs-stats.ts — one-shot dispatch-ledger statistics for budget calibration.
 *
 * Parses the durable subagent run records (~/.pi/subagents/runs/*.json) and
 * emits status counts + per-status token medians — the inputs the
 * dispatch-budget-rebalance skill's procedure step 1 calls for. The >=100-run
 * re-measure gate (#1663) is checked against these numbers, never intuition.
 *
 * Usage: bun scripts/runs-stats.ts [runs-dir]   (default ~/.pi/subagents/runs)
 * Exit 0 always (stats tool, not a gate).
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? join(homedir(), ".pi", "subagents", "runs");
type Rec = { status?: string; usage?: { total?: number }; turns?: { turnsUsed?: number } };

const recs: Rec[] = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  try {
    recs.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Rec);
  } catch {
    /* skip malformed */
  }
}

const byStatus = new Map<string, { n: number; tokens: number[]; turns: number[] }>();
for (const r of recs) {
  const s = r.status ?? "unknown";
  const b = byStatus.get(s) ?? { n: 0, tokens: [], turns: [] };
  b.n += 1;
  if (typeof r.usage?.total === "number") b.tokens.push(r.usage.total);
  if (typeof r.turns?.turnsUsed === "number") b.turns.push(r.turns.turnsUsed);
  byStatus.set(s, b);
}

const med = (xs: number[]): number | null =>
  xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`runs-dir: ${dir}`);
console.log(`total: ${recs.length}`);
for (const [s, b] of [...byStatus.entries()].sort((a, c) => c[1].n - a[1].n)) {
  const t = med(b.tokens);
  const u = med(b.turns);
  console.log(`${s}: n=${b.n} tokenMedian=${t ?? "-"} turnsMedian=${u ?? "-"}`);
}
