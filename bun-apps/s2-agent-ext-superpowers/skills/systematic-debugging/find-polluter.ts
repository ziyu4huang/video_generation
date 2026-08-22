#!/usr/bin/env bun
// Bisection script to find which test creates unwanted files/state.
// Portable bun twin of the former find-polluter.sh (same dir, deleted when
// parity went green) — stdout lines + exit codes byte-identical, pinned by
// tests/find-polluter-parity.test.ts.
//
// Usage: find-polluter.ts <file_or_dir_to_check> <test_pattern>
// Example: find-polluter.ts '.git' 'src/**/*.test.ts'
//
// Run (from the repo under investigation — the script searches `.`):
//   bun <path>/skills/systematic-debugging/find-polluter.ts '.git' 'src/**/*.test.ts'
//
// Behavior ported verbatim from the .sh: `find . -path` matches the pattern
// verbatim against ./-prefixed pathnames (a bare `src/**` pattern matches
// nothing — pass `./src/**`; the upstream-fixed find-polluter.sh strips the
// ./ prefix, deliberately NOT ported here, see the test's provenance header).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Bash $0 equivalent: how the script was invoked. (bun normalizes argv[1] to
// an absolute path whereas bash kept $0 as invoked — the usage golden is built
// from the spawn path; the two differ only in the .sh/.ts extension bytes.)
const PROG = process.argv[1] ?? "find-polluter.ts";

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.log(`Usage: ${PROG} <file_to_check> <test_pattern>`);
  console.log(`Example: ${PROG} '.git' 'src/**/*.test.ts'`);
  process.exit(1);
}

const POLLUTION_CHECK = args[0];
const TEST_PATTERN = args[1];

console.log(`🔍 Searching for test that creates: ${POLLUTION_CHECK}`);
console.log(`Test pattern: ${TEST_PATTERN}`);
console.log("");

// Get list of test files (port of `find . -path "$TEST_PATTERN"`).
const found = spawnSync("find", [".", "-path", TEST_PATTERN], {
  cwd: process.cwd(),
  encoding: "utf8",
});
if (found.error || found.status !== 0) {
  // set -e: a failed find aborts the .sh with find's stderr shown
  console.error(found.stderr ?? `find failed: ${found.error?.message ?? `exit ${found.status}`}`);
  process.exit(found.status ?? 1);
}

// Port of `TEST_FILES=$(find ... | sort)` + `for f in $TEST_FILES` word-splitting
// (IFS whitespace — a name containing spaces breaks identically to the .sh).
const TEST_FILES = (found.stdout ?? "")
  .split("\n")
  .filter((l) => l !== "")
  .sort()
  .join("\n")
  .split(/\s+/)
  .filter(Boolean);

// Port of `echo "$TEST_FILES" | wc -l | tr -d ' '` — echo of an already-newline-
// stripped empty string still emits one newline, so zero files counts as 1.
// (.sh quirk, mirrored; harmless — the loop body never runs for zero files.)
const TOTAL = TEST_FILES.length === 0 ? 1 : TEST_FILES.length;

console.log(`Found ${TOTAL} test files`);
console.log("");

let COUNT = 0;
for (const TEST_FILE of TEST_FILES) {
  COUNT += 1;

  // Skip if pollution already exists
  if (existsSync(isAbsolute(POLLUTION_CHECK) ? POLLUTION_CHECK : join(process.cwd(), POLLUTION_CHECK))) {
    console.log(`⚠️  Pollution already exists before test ${COUNT}/${TOTAL}`);
    console.log(`   Skipping: ${TEST_FILE}`);
    continue;
  }

  console.log(`[${COUNT}/${TOTAL}] Testing: ${TEST_FILE}`);

  // Run the test (port of `npm test "$TEST_FILE" > /dev/null 2>&1 || true`)
  spawnSync("npm", ["test", TEST_FILE], { cwd: process.cwd(), stdio: "ignore" });

  // Check if pollution appeared
  if (existsSync(isAbsolute(POLLUTION_CHECK) ? POLLUTION_CHECK : join(process.cwd(), POLLUTION_CHECK))) {
    console.log("");
    console.log("🎯 FOUND POLLUTER!");
    console.log(`   Test: ${TEST_FILE}`);
    console.log(`   Created: ${POLLUTION_CHECK}`);
    console.log("");
    console.log("Pollution details:");
    const ls = spawnSync("ls", ["-la", POLLUTION_CHECK], { cwd: process.cwd(), encoding: "utf8" });
    process.stdout.write(ls.stdout ?? "");
    console.log("");
    console.log("To investigate:");
    console.log(`  npm test ${TEST_FILE}    # Run just this test`);
    console.log(`  cat ${TEST_FILE}         # Review test code`);
    process.exit(1);
  }
}

console.log("");
console.log("✅ No polluter found - all tests clean!");
process.exit(0);
