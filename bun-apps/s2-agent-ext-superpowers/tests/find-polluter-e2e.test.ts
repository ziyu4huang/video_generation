// find-polluter.ts end-to-end: real bisection against a real fixture — the
// tool must actually FIND a pollution-producing test (issue #1862).
//
// The upstream port (./-strip + **/-collapse + TOTAL=0) is pinned here as
// behavior, not as byte-parity: the pre-fix script matched zero test files
// for the documented pattern (`src/**/*.test.ts` — find emits ./-prefixed
// paths) and reported `✅ No polluter found` unconditionally, with the
// TOTAL=0 quirk printing `Found 1 test files` for zero matches.
//
// Hermetic `npm`: the tool's contract is `npm test <file>`; a PATH shim
// forwards to `bun test` so no node/npm install is required on the host.

import { afterAll, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScript } from "../../tests/helpers/bash-parity";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_ABS = join(PKG_DIR, "skills/systematic-debugging/find-polluter.ts");

// One fixture per case (bisection runs mutate the pollution sentinel, so
// cases cannot share a tree). Each fixture gets: package.json (npm test →
// bun test), a bin/npm shim on PATH, and case-specific test files.
function makeFixture(testFiles: Record<string, string>): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "fp-e2e-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fp-e2e", scripts: { test: "bun test" } }));
  for (const [rel, body] of Object.entries(testFiles)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const binDir = join(dir, "bin");
  FIXTURES.push(dir);
  mkdirSync(binDir);
  // npm shim: forward `npm test <file>` to `bun test <file>`.
  writeFileSync(join(binDir, "npm"), '#!/bin/sh\nexec bun test "$2"\n');
  chmodSync(join(binDir, "npm"), 0o755);
  return { dir, env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } };
}

const CLEAN_TEST = `import { test, expect } from "bun:test";
test("clean", () => { expect(1).toBe(1); });
`;
const POLLUTER_TEST = (sentinel: string) => `import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
test("pollutes", () => { writeFileSync("${sentinel}", "dirty"); expect(true).toBe(true); });
`;

const FIXTURES: string[] = [];

afterAll(() => {
  for (const dir of FIXTURES) rmSync(dir, { recursive: true, force: true });
});

test("e2e: documented pattern (no ./ prefix) finds the polluter", () => {
  const { dir, env } = makeFixture({
    "src/sub/clean.test.ts": CLEAN_TEST,
    "src/sub/polluter.test.ts": POLLUTER_TEST("SENTINEL-1"),
  });
  const r = runScript("bun", SCRIPT_ABS, ["SENTINEL-1", "src/**/*.test.ts"], { cwd: dir, env });
  if (r.code !== 1) throw new Error(`expected exit 1 (FOUND POLLUTER), got ${r.code}\nstdout:\n${r.stdout}`);
  if (!r.stdout.includes("🎯 FOUND POLLUTER!")) throw new Error(`stdout missing FOUND POLLUTER:\n${r.stdout}`);
  if (!r.stdout.includes("src/sub/polluter.test.ts")) throw new Error(`stdout missing polluter path:\n${r.stdout}`);
});

test("e2e: **/ collapse — pattern must match files directly under the base dir", () => {
  const { dir, env } = makeFixture({
    "src/polluter.test.ts": POLLUTER_TEST("SENTINEL-2"),
  });
  const r = runScript("bun", SCRIPT_ABS, ["SENTINEL-2", "src/**/*.test.ts"], { cwd: dir, env });
  if (r.code !== 1) throw new Error(`expected exit 1 (FOUND POLLUTER), got ${r.code}\nstdout:\n${r.stdout}`);
  if (!r.stdout.includes("src/polluter.test.ts")) throw new Error(`stdout missing polluter path:\n${r.stdout}`);
});

test("e2e: zero matches report Found 0 test files (not the 0→1 quirk)", () => {
  const { dir, env } = makeFixture({ "src/sub/a.test.ts": CLEAN_TEST });
  const r = runScript("bun", SCRIPT_ABS, ["NOPE", "tests/**/*.spec.ts"], { cwd: dir, env });
  if (r.code !== 0) throw new Error(`expected exit 0, got ${r.code}\nstdout:\n${r.stdout}`);
  if (!r.stdout.includes("Found 0 test files")) throw new Error(`stdout missing 'Found 0 test files':\n${r.stdout}`);
});
