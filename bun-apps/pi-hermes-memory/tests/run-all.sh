#!/usr/bin/env bash
# Run each pi-hermes-memory test file in its OWN tsx (Node) process.
#
# WHY per-file tsx (Node) isolation — two root-caused reasons (2026-07-09,
# test-determinism cycle):
#
# 1. The hang (single-process). `bun test` runs test files CONCURRENTLY on a
#    shared thread, and this package mixes synchronous native SQLite
#    (better-sqlite3) with async file-I/O tests (memory-store). The SQLite ops
#    starve memory-store's async atomic-write path, intermittently stalling the
#    "handles very long entry near char limit" test for ~900s. Per-file process
#    isolation removes the shared-thread contention.
#
# 2. The bun+linux quirk. `bun test` runs all 585 tests fine on macOS, BUT
#    bun's better-sqlite3 binding fails the corruption-recovery test
#    (db.test.ts: "repairs recoverable corruption on open and preserves
#    readable rows") on the CI runner (ubuntu-latest) — it recovers rows
#    differently than Node's binding. tsx (Node) passes it on every platform.
#
# Net: tsx (Node) per-file is the proven CI runner (#383–#391 green). A single
# `bun test` is fine for a quick LOCAL check on macOS but is neither reliable
# (the hang) nor correct (the linux corruption quirk) for the gate. See
# .github/TEST-DETERMINISM.md (D3). Requires Node on PATH (npx tsx).
set -euo pipefail

PASS=0

for f in $(find tests -name '*.test.ts' | sort); do
  npx tsx --test "$f" >/dev/null 2>&1 || { echo "FAILED: $f" >&2; npx tsx --test "$f" >&2; exit 1; }
  PASS=$((PASS + 1))
done

echo "All $PASS test files passed"
