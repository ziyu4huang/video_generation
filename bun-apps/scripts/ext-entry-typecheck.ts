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
let ran = 0;

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

  const proc = Bun.spawnSync(["bun", "run", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  ran++;
  if (proc.exitCode === 0) {
    console.log(`  ok   ${name} (${script})`);
    continue;
  }
  failures.push(name);
  console.log(`  FAIL ${name} (${script})`);
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trimEnd();
  if (out) console.log(out.replace(/^/gm, "       "));
}

console.log(`\n${ran} extension package(s) typechecked, ${failures.length} failed.`);
if (skipped.length > 0) console.log(`no tsc script (see the extension-entry guard): ${skipped.join(", ")}`);
if (failures.length > 0 || skipped.length > 0) process.exit(1);
