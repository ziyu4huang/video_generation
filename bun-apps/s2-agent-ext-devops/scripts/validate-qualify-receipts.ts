/**
 * Runnable entry for src/validate-qualify-receipts.ts — the INDEPENDENT
 * grader for qualify sweep receipts (self-arc-21). Re-grades every scenario
 * receipt from primary evidence (model line, snap files, settle content,
 * summary cross-check) without consulting the harness's own pass fields.
 *
 *   bun bun-apps/s2-agent-ext-devops/scripts/validate-qualify-receipts.ts <sweep-dir>
 *
 * JSON on stdout, diagnostics on stderr. Exit 0 derived-green and agreeing /
 * 1 derived-red or self-grade disagreement / 2 usage error.
 */

import { isAbsolute, resolve } from "node:path";
import { validateQualifySweep } from "../src/validate-qualify-receipts.js";

function main(argv: string[]): number {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    console.error("usage: validate-qualify-receipts.ts <sweep-dir>   (the qualify sweep output dir: scenario subdirs + summary.json)");
    return 2;
  }
  const arg = argv.filter((a) => !a.startsWith("--"))[0];
  if (!arg) {
    console.error("usage: validate-qualify-receipts.ts <sweep-dir> — exactly one sweep dir");
    return 2;
  }
  const sweepDir = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  const res = validateQualifySweep(sweepDir);
  console.log(JSON.stringify(res, null, 2));
  for (const p of res.problems) console.error(`problem: ${p}`);
  for (const s of res.scenarios) {
    for (const p of s.problems) console.error(`${s.scenario}: ${p}`);
    if (s.agree === false) console.error(`${s.scenario}: SELF-GRADE DISAGREES (receipt pass=${String(s.selfPass)}, re-derived pass=${String(s.derivedPass)})`);
  }
  if (!res.ok) return 1;
  if (!res.allAgree) return 1;
  return 0;
}

process.exit(main(process.argv.slice(2)));
