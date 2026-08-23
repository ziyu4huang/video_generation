#!/usr/bin/env bun
/**
 * Run every extension package's own tsc script.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE GUARD
 *   `tests/extension-entry-typechecked.test.ts` asserts the STATIC contract: the
 *   package has a tsconfig, its `include` covers `extensions/*.ts`, and some
 *   script invokes tsc. All three can hold while nothing ever runs that script —
 *   the CI matrix gives most of these packages a plain `bun test`, which does not
 *   chain typecheck. Coverage with no executor reads as fixed and is not (the
 *   package-scripts-runnable lesson). This is the executor.
 *
 * Package discovery repeats the guard's rule (a directory with `extensions/` and
 * at least one non-test `.ts` in it) rather than importing it, so this script has
 * no test-file dependency. Drift is not a risk: the guard fails first if a
 * package loses its tsc script, and a package this script cannot find is a
 * package the guard also cannot find.
 *
 * Run: bun run typecheck:ext   (from bun-apps/)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BUN_APPS = resolve(import.meta.dir, "..");

/** Same rule as the guard: `.ts` under `extensions/`, minus tests and declarations. */
const isEntryFile = (f: string): boolean => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts");

/** The script whose command line invokes tsc, bare or via bunx/npx. */
function tscScript(pkg: { scripts?: Record<string, string> }): string | null {
  const scripts = pkg.scripts ?? {};
  const names = Object.entries(scripts)
    .filter(([, cmd]) => /(^|[\s&|;(])(?:bunx\s+|npx\s+)?tsc(\s|$)/.test(cmd))
    .map(([name]) => name);
  // Prefer the conventional name so a package with both `build` (emits) and
  // `typecheck` (--noEmit) takes the cheap one.
  return names.find((n) => n === "typecheck") ?? names.find((n) => n === "check") ?? names[0] ?? null;
}

const failures: string[] = [];
const skipped: string[] = [];

// Discovery first, THEN a bounded-parallel run. The former serial spawnSync
// loop was measured at 184 s for ~27 packages (2026-08-23 gate timing probe) —
// each package's tsc is an independent read-only process, so they run with
// POOL-wide concurrency 6 (18 logical cores here; tsc is CPU-bound). Output
// stays deterministic: results are printed in package order, never completion
// order, so log diffs and grep-based expectations do not flake.
interface Job {
  name: string;
  dir: string;
  script: string;
}
const jobs: Job[] = [];
for (const name of readdirSync(BUN_APPS).sort()) {
  const dir = join(BUN_APPS, name);
  const extDir = join(dir, "extensions");
  if (!existsSync(join(dir, "package.json"))) continue;
  if (!existsSync(extDir) || !statSync(extDir).isDirectory()) continue;
  if (!readdirSync(extDir).some(isEntryFile)) continue;

  const script = tscScript(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
  if (!script) {
    // The guard blocks on this; here it is reported, not silently passed over.
    skipped.push(name);
    continue;
  }
  jobs.push({ name, dir, script });
}

const POOL = 6;
const results = new Array< { ok: boolean; output: string } | null >(jobs.length).fill(null);
let next = 0;
async function worker(): Promise<void> {
  while (next < jobs.length) {
    const i = next++;
    const job = jobs[i]!;
    const proc = Bun.spawnSync(["bun", "run", job.script], { cwd: job.dir, stdout: "pipe", stderr: "pipe" });
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trimEnd();
    results[i] = { ok: proc.exitCode === 0, output: out };
  }
}
await Promise.all(Array.from({ length: Math.max(1, Math.min(POOL, jobs.length)) }, worker));

jobs.forEach((job, i) => {
  const r = results[i];
  if (!r) return; // unreachable: every job index is claimed by a worker
  if (r.ok) {
    console.log(`  ok   ${job.name} (${job.script})`);
    return;
  }
  failures.push(job.name);
  console.log(`  FAIL ${job.name} (${job.script})`);
  if (r.output) console.log(r.output.replace(/^/gm, "       "));
});
const ran = jobs.length;

console.log(`\n${ran} extension package(s) typechecked, ${failures.length} failed.`);
if (skipped.length > 0) console.log(`no tsc script (see the extension-entry guard): ${skipped.join(", ")}`);
if (failures.length > 0 || skipped.length > 0) process.exit(1);
