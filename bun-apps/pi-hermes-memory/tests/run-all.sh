#!/usr/bin/env bash
# Run each pi-hermes-memory test file in its OWN bun process.
#
# WHY per-file process isolation (root-caused 2026-07-09, test-determinism cycle):
# The suite's 585 tests pass under a single `bun test`, BUT bun runs test files
# CONCURRENTLY on a shared thread, and this package mixes synchronous native
# SQLite (better-sqlite3, in db/session-indexer/skill tests) with async file-I/O
# tests (memory-store). The synchronous SQLite ops block the main thread and
# STARVE the async fs callbacks of memory-store's atomic-write path; under
# contention this intermittently stalls the "handles very long entry near char
# limit" test for ~900s (15 min) — a cross-RUN flake that would block the
# mandatory CI gate. Per-file process isolation (one bun per file) removes the
# shared-thread contention entirely: each file gets its own event loop, so no
# synchronous-op leak can starve another file's async I/O. PROVEN reliable
# (this isolation shape kept CI green #383–#391; only the runner was tsx then).
#
# This is the test-determinism criterion-4 option (b) disposition: root-caused
# (concurrent synchronous SQLite starvation, NOT the old "node:test runner bug"
# myth) + workaround retained. A single-process run is fine for a quick local
# check (`bun test`) but is NOT reliable enough for the mandatory gate. See
# .github/TEST-DETERMINISM.md (D3).
#
# Uses `bun test` (not `npx tsx`) — bun runs node:test-style files natively, so
# no Node/tsx setup is required.
set -euo pipefail

PASS=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for f in $(find tests -name '*.test.ts' | sort); do
  bun test "$f" >/dev/null 2>&1 || { echo "FAILED: $f" >&2; bun test "$f" >&2; exit 1; }
  PASS=$((PASS + 1))
done

echo "All $PASS test files passed"
