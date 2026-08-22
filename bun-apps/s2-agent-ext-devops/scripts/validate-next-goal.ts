/**
 * Runnable entry for src/validate-next-goal.ts — the machine gate under the
 * self-reflect-next-goal skill's strict handoff format.
 *
 *   bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts            # doctor: LATEST pointer + newest file + retention
 *   bun bun-apps/s2-agent-ext-devops/scripts/validate-next-goal.ts <file>...  # validate specific file(s)
 *
 * JSON on stdout, diagnostics on stderr. Exit 0 ok / 1 validation failed /
 * 2 usage error.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { doctorNextGoal, validateNextGoalFile } from "../src/validate-next-goal.js";

/** Walk up from `from` to the dir that owns output/ (has .git or an existing output/). */
function findRepoRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(resolve(dir, "output")) && existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function main(argv: string[]): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.error("usage: validate-next-goal.ts [file ...]   (no args = doctor the nearest repo root's output/)");
    return 2;
  }
  if (argv.length === 0) {
    const root = findRepoRoot(process.cwd());
    if (!root) {
      console.error("no repo root found above cwd (need a dir with .git + output/)");
      return 2;
    }
    const d = doctorNextGoal(resolve(root, "output"));
    console.log(JSON.stringify(d, null, 2));
    for (const p of d.problems) console.error(`problem: ${p}`);
    return d.ok ? 0 : 1;
  }
  let allOk = true;
  const results = [];
  for (const arg of argv) {
    const abs = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
    const v = validateNextGoalFile(abs);
    allOk = allOk && v.ok;
    results.push(v);
    for (const c of v.checks.filter((c2) => !c2.ok)) console.error(`${abs}: ${c.name}: ${c.detail ?? ""}`);
  }
  console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  return allOk ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
