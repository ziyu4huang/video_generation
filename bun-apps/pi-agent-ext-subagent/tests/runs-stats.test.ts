// Hermetic test for scripts/runs-stats.ts — spawns the CLI against a tmp
// runs-dir of fixture records (never the real ~/.pi/subagents/runs DB).
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "scripts", "runs-stats.ts"), dir], {
      cwd: import.meta.dir,
    });
    const out = new TextDecoder().decode(proc.stdout);
    assert.ok(proc.exitCode === 0, `expected exit 0, got ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr)}`);
    assert.ok(out.includes("total: 5"), `stdout missing total: 5\n${out}`);
    assert.ok(out.includes("done: n=3 tokenMedian=200"), `stdout missing done row\n${out}`);
    assert.ok(out.includes("turns: n=2 tokenMedian=700 turnsMedian=12"), `stdout missing turns row\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
