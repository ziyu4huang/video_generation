#!/usr/bin/env node
/**
 * §-union merge driver for project memory (autocommit-hook effort, ticket 05).
 *
 * Git invokes this as:  <runtime> pi-memory-merge.mjs %O %A %B
 *   %O = base (merge base)   %A = ours (current — ALSO the merge OUTPUT target)
 *   %B = theirs (incoming)
 *
 * It splits each side on the § entry delimiter, unions entries by trimmed
 * content (dedup), and writes the result to %A — so two branches that each
 * APPENDED entries both survive and common base entries aren't duplicated.
 * True edit-conflicts (same entry changed on both sides) keep both versions;
 * consolidation merges them later. Exits 0 for a clean union; non-zero lets
 * git fall back to a normal conflict (never data loss).
 *
 * This script is SELF-CONTAINED (no imports beyond node:fs) and dependency/
 * TypeScript-free so it runs under either `node` or `bun` during a `git merge`
 * — the runtime is whatever `process.execPath` was at self-config time. The
 * SAME logic lives as a pure, unit-tested function in src/merge-union.ts; if
 * you change the algorithm here, mirror it there.
 */

import { readFileSync, writeFileSync } from "node:fs";

const DELIMITER = "\n§\n";

function splitEntries(content) {
  if (!content) return [];
  return content
    .split(DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function unionEntries(base, ours, theirs) {
  const result = [];
  const seen = new Set();
  for (const list of [base, ours, theirs]) {
    for (const entry of list) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function main() {
  const [, , baseArg, oursArg, theirsArg] = process.argv;
  if (!baseArg || !oursArg || !theirsArg) {
    process.stderr.write("pi-memory-merge: expected %O %A %B arguments\n");
    process.exit(2);
  }
  try {
    const base = splitEntries(readFileSync(baseArg, "utf-8"));
    const ours = splitEntries(readFileSync(oursArg, "utf-8"));
    const theirs = splitEntries(readFileSync(theirsArg, "utf-8"));
    const merged = unionEntries(base, ours, theirs);
    // %A is the output target; trailing newline matches the MEMORY.md format.
    writeFileSync(oursArg, merged.join(DELIMITER) + (merged.length ? "\n" : ""));
    process.exit(0); // clean union — git accepts %A as the merged result
  } catch (err) {
    process.stderr.write(`pi-memory-merge: ${err?.message ?? String(err)}\n`);
    process.exit(1); // let git fall back to a normal conflict
  }
}

main();
