// Hermetic test for scripts/runs-stats.ts — spawns the CLI against tmp
// runs-dirs / tmp history files (never the real ~/.pi/subagents/runs DB or
// the package docs/budget-history.jsonl).
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "runs-stats.ts");

const runCli = (args: string[]) => {
  const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: import.meta.dir });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  assert.ok(proc.exitCode === 0, `expected exit 0, got ${proc.exitCode}: ${stderr}`);
  return { stdout, stderr };
};

const jsonlRows = (file: string): string[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");

test("runs-stats reports status counts and per-status medians for a fixture runs-dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-stats-"));
  try {
    const rec = (o: Record<string, unknown>) =>
      writeFileSync(join(dir, `${crypto.randomUUID()}.json`), JSON.stringify(o));
    // 3 done runs (token medians -> 200), 2 turns runs (token median 700, turns median 12).
    rec({ status: "done", usage: { total: 100 } });
    rec({ status: "done", usage: { total: 200 } });
    rec({ status: "done", usage: { total: 300 } });
    rec({ status: "turns", usage: { total: 500 }, turns: { turnsUsed: 8 } });
    rec({ status: "turns", usage: { total: 700 }, turns: { turnsUsed: 12 } });

    const out = runCli([dir]).stdout;
    assert.ok(out.includes("total: 5"), `stdout missing total: 5\n${out}`);
    assert.ok(out.includes("done: n=3 tokenMedian=200"), `stdout missing done row\n${out}`);
    assert.ok(out.includes("turns: n=2 tokenMedian=700 turnsMedian=12"), `stdout missing turns row\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cohort split groups runs by budget.source with untagged records as unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-stats-cohort-"));
  try {
    const rec = (o: Record<string, unknown>) =>
      writeFileSync(join(dir, `${crypto.randomUUID()}.json`), JSON.stringify(o));
    // envelope-recon: n=3 (2 done, 1 turns), tokenMedian=300.
    rec({ status: "done", usage: { total: 100 }, budget: { source: "envelope-recon" } });
    rec({ status: "done", usage: { total: 300 }, budget: { source: "envelope-recon" } });
    rec({ status: "turns", usage: { total: 500 }, budget: { source: "envelope-recon" } });
    // envelope-writer: n=1 done, tokenMedian=200.
    rec({ status: "done", usage: { total: 200 }, budget: { source: "envelope-writer" } });
    // explicit: n=1 turns, tokenMedian=700.
    rec({ status: "turns", usage: { total: 700 }, turns: { turnsUsed: 12 }, budget: { source: "explicit" } });
    // legacy untagged record -> unknown cohort.
    rec({ status: "done", usage: { total: 400 } });

    const out = runCli([dir]).stdout;
    assert.ok(out.includes("total: 6"), `stdout missing total: 6\n${out}`);
    assert.ok(out.includes("done: n=4 tokenMedian=300"), `stdout missing done status row\n${out}`);
    assert.ok(out.includes("turns: n=2 tokenMedian=700 turnsMedian=12"), `stdout missing turns status row\n${out}`);
    assert.ok(
      out.includes("cohort envelope-recon: n=3 done=2 turns=1 budget=0 tokenMedian=300"),
      `stdout missing envelope-recon cohort row\n${out}`,
    );
    assert.ok(
      out.includes("cohort envelope-writer: n=1 done=1 turns=0 budget=0 tokenMedian=200"),
      `stdout missing envelope-writer cohort row\n${out}`,
    );
    assert.ok(
      out.includes("cohort explicit: n=1 done=0 turns=1 budget=0 tokenMedian=700"),
      `stdout missing explicit cohort row\n${out}`,
    );
    assert.ok(
      out.includes("cohort unknown: n=1 done=1 turns=0 budget=0 tokenMedian=400"),
      `stdout missing unknown cohort row\n${out}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--snapshot appends exactly one JSON line (note optional) to a tmp history file", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-stats-snap-"));
  try {
    const hist = join(dir, "budget-history.jsonl");
    const rec = (o: Record<string, unknown>) =>
      writeFileSync(join(dir, `${crypto.randomUUID()}.json`), JSON.stringify(o));
    rec({ status: "done", usage: { total: 100 }, budget: { source: "envelope-recon" } });
    rec({ status: "turns", usage: { total: 500 }, budget: { source: "envelope-recon" } });

    const out = runCli([dir, "--snapshot", hist, "--note", "calibration"]).stdout;
    const rows = jsonlRows(hist);
    assert.equal(rows.length, 1, `expected exactly 1 history line, got ${rows.length}`);
    const row = JSON.parse(rows[0] as string) as {
      date: string;
      totalRuns: number;
      note: string;
      cohorts: Record<string, unknown>;
    };
    assert.equal(row.totalRuns, 2);
    assert.ok(!Number.isNaN(Date.parse(row.date)), `bad date ${row.date}`);
    assert.equal(row.note, "calibration");
    assert.deepEqual(row.cohorts["envelope-recon"], {
      n: 2,
      done: 1,
      turns: 1,
      budget: 0,
      timedout: 0,
      tokenMedian: 500,
    });
    // The appended line is echoed to stdout.
    assert.ok(out.includes(rows[0] as string), `stdout should echo the appended line\n${out}`);

    // Without --note the key is absent; a second call appends exactly one more line.
    runCli([dir, "--snapshot", hist]);
    const rows2 = jsonlRows(hist);
    assert.equal(rows2.length, 2, `expected exactly 2 history lines, got ${rows2.length}`);
    const row2 = JSON.parse(rows2[1] as string) as Record<string, unknown>;
    assert.ok(!("note" in row2), `note key should be absent without --note\n${rows2[1]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--trend renders rows with runsSinceLast and gates in both directions", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-stats-trend-"));
  try {
    const hist = join(dir, "budget-history.jsonl");
    const rec = (o: Record<string, unknown>) =>
      writeFileSync(join(dir, `${crypto.randomUUID()}.json`), JSON.stringify(o));
    const tag = (i: number) => (i % 2 === 0 ? "envelope-recon" : "explicit");

    // 3 tagged runs -> snapshot 1.
    for (let i = 0; i < 3; i++) rec({ status: "done", usage: { total: 100 + i }, budget: { source: tag(i) } });
    runCli([dir, "--snapshot", hist]);

    // Single-row history: delta vs 0 = totalRuns.
    let out = runCli(["--trend", hist]).stdout;
    assert.ok(out.includes("runsSinceLast=3"), `single-row trend missing runsSinceLast=3\n${out}`);
    assert.ok(out.includes("GATE: NOT ARMED (need 97 more)"), `single-row gate wrong\n${out}`);
    assert.ok(out.includes("envelope-recon n=2 tokenMedian=102"), `missing compact cohort medians\n${out}`);

    // +2 runs -> snapshot 2 (delta 2 < 100 -> NOT ARMED).
    for (let i = 0; i < 2; i++) rec({ status: "turns", usage: { total: 900 }, budget: { source: "explicit" } });
    runCli([dir, "--snapshot", hist]);
    out = runCli(["--trend", hist]).stdout;
    assert.ok(out.includes("total=3") && out.includes("total=5"), `both rows must render\n${out}`);
    assert.ok(out.includes("runsSinceLast=3"), `row 1 runsSinceLast wrong\n${out}`);
    assert.ok(out.includes("runsSinceLast=2"), `row 2 runsSinceLast wrong\n${out}`);
    assert.ok(out.includes("GATE: NOT ARMED (need 98 more)"), `delta<100 gate wrong\n${out}`);

    // +100 untagged runs -> snapshot 3 (delta 100 >= 100 -> ARMED).
    for (let i = 0; i < 100; i++) rec({ status: "done", usage: { total: 1 } });
    runCli([dir, "--snapshot", hist]);
    out = runCli(["--trend", hist]).stdout;
    assert.ok(out.includes("runsSinceLast=100"), `row 3 runsSinceLast wrong\n${out}`);
    assert.ok(out.includes("GATE: 100 runs since last snapshot — ARMED"), `delta>=100 gate wrong\n${out}`);
    assert.equal(jsonlRows(hist).length, 3, `history should hold exactly 3 snapshots`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--seed-history is idempotent: writes 3 rows once, then skips", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-stats-seed-"));
  try {
    const hist = join(dir, "budget-history.jsonl");
    const first = runCli(["--seed-history", hist]);
    const rows = jsonlRows(hist);
    assert.equal(rows.length, 3, `expected 3 seed rows, got ${rows.length}`);
    const parsed = rows.map((r) => JSON.parse(r) as { seed?: boolean; totalRuns?: number; note?: string });
    assert.ok(
      parsed.every((r) => r.seed === true && r.totalRuns === 200),
      `seed rows malformed\n${rows.join("\n")}`,
    );
    assert.ok(parsed[0]?.note?.includes("pre-rebalance baseline"), `row 1 note wrong\n${rows[0]}`);
    assert.ok(parsed[2]?.note?.includes("motivates the cohort split"), `row 3 note wrong\n${rows[2]}`);
    assert.ok(first.stdout.includes("pre-rebalance baseline"), `seed should echo written rows\n${first.stdout}`);

    const second = runCli(["--seed-history", hist]);
    assert.ok(second.stdout.includes("seed: skipped"), `second call must skip\n${second.stdout}`);
    assert.equal(jsonlRows(hist).length, 3, `history must stay at 3 rows after second call`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
