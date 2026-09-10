/**
 * Runnable entry for src/repoint-next-goal.ts — the WRITE-path twin of
 * validate-next-goal (self-arc-19 t02): validate the target, delete
 * byte-duplicate stale goal files (newest filename wins), verify supersedes
 * ordering, atomically repoint output/LATEST-next-goal.md, doctor the queue.
 *
 *   bun bun-apps/s2-agent-ext-devops/scripts/repoint-next-goal.ts <target> [--check]
 *
 * --check is a dry-run: report the plan (validations, deletions, re-target),
 * write nothing. JSON on stdout, diagnostics on stderr. Exit 0 ok / 1 failed /
 * 2 usage error.
 */

import { dirname, isAbsolute, resolve } from "node:path";
import { execRepoint, planRepoint } from "../src/repoint-next-goal.js";

function main(argv: string[]): number {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    console.error("usage: repoint-next-goal.ts <target-file> [--check]   (--check = dry-run, writes nothing)");
    return 2;
  }
  const check = argv.includes("--check");
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) {
    console.error("usage: repoint-next-goal.ts <target-file> [--check] — exactly one target file");
    return 2;
  }
  const arg = positional[0];
  const target = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  const plan = planRepoint(dirname(target), target);
  const result = execRepoint(plan, { check });
  console.log(JSON.stringify(result, null, 2));
  for (const p of result.problems) console.error(`${p}`);
  if (!result.ok) return 1;
  if (check) {
    for (const d of result.deletions)
      console.error(`[check] would delete ${d.file} (byte-duplicate of ${d.newerTwin})`);
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
