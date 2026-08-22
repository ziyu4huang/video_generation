#!/usr/bin/env bun
// Hermetic smoke for the playwright-cli skill — portable bun twin of the
// deleted smoke.sh (see tests/smoke-parity.test.ts for the pinned golden, and
// the A/B bytes that kept this file honest while the .sh was alive).
//
// Proves the deploy-integrity contract: `bunx playwright-cli` resolves THIS
// extension's pinned @playwright/cli dep — exact version match, which rules out
// the unrelated npm package literally named `playwright-cli` (v0.262.0) that
// `npx playwright-cli` would fetch. Does NOT launch a browser (that needs
// `bunx playwright-cli install-browser`); this gates the invocation path, not
// engine/browser availability.
//
// Run: bun skills/playwright-cli/scripts/smoke.ts

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Script lives at <power-tool>/skills/playwright-cli/scripts/smoke.ts
// → power-tool root is three levels up (mirrors smoke.sh's BASH_SOURCE dance;
// the cwd matters — bunx must resolve from the package root's node_modules).
const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
process.chdir(EXT_ROOT);

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Exact version installed in node_modules — what bunx MUST resolve to.
// Mirrors `grep -m1 '"version"' node_modules/@playwright/cli/package.json
// | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'` (first `"version"` line, first semver
// triple on it) so the string agrees with smoke.sh's extraction exactly.
function pinnedVersion(): string {
  const pkg = join(EXT_ROOT, "node_modules/@playwright/cli/package.json");
  if (!existsSync(pkg)) fail("node_modules/@playwright/cli not installed — run 'bun install'");
  const line = readFileSync(pkg, "utf8").split("\n").find((l) => l.includes('"version"'));
  const m = /\d+\.\d+\.\d+/.exec(line ?? "");
  if (!m) fail("node_modules/@playwright/cli not installed — run 'bun install'");
  return m[0];
}

// Run bunx with the same silencing smoke.sh used: `--version` keeps stdout
// (captured, stderr discarded); `list` discards both (>/dev/null 2>&1).
// spawn-failure maps to 127 (bash: "command not found").
function bunx(args: string[]): { stdout: string; code: number } {
  const r = spawnSync("bunx", args, { cwd: EXT_ROOT, encoding: "utf8" });
  if (r.error) return { stdout: "", code: 127 };
  return { stdout: r.stdout ?? "", code: r.status ?? -1 };
}

const pinned = pinnedVersion();

// 1. binary resolves + runs, reporting the EXACT pinned version (rules out the
//    npm playwright-cli@0.262.0 naming collision, which would report 0.262.x).
const v = bunx(["playwright-cli", "--version"]);
if (v.code !== 0) {
  fail(`bunx playwright-cli --version exited ${v.code} — dep not resolvable from ${EXT_ROOT}`);
}
const version = v.stdout.replace(/\n+$/g, ""); // `$(…)` strips trailing newlines
if (version !== pinned) {
  fail(
    `bunx resolved version '${version}' != pinned @playwright/cli '${pinned}' — wrong package (npm playwright-cli@0.262.0 collision?)`,
  );
}
console.log(`ok: bunx playwright-cli --version => ${version} (== pinned @playwright/cli)`);

// 2. a real subcommand that does not launch a browser (lists browser sessions).
const l = bunx(["playwright-cli", "list"]);
if (l.code !== 0) fail(`bunx playwright-cli list exited ${l.code}`);
console.log("ok: bunx playwright-cli list");

console.log("playwright-cli skill smoke: PASS");
