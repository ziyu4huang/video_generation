// dedup parity: dedup.ts must byte-match the old dedup.sh stdout + exit codes.
//
// Provenance — goldens captured 2026-08-23 from the live old script:
//   dedup.sh@072bfaa8 (this skill dir, pre-rename path; file deleted when
//   parity went green). One deliberate post-capture divergence: the HELP
//   golden's skill-name line says the RENAMED name (slash-surface t02,
//   2026-08-29) — dedup.ts's HELP and this golden changed together.
//   Capture was run via `bash <dedup.sh> <args>` on the fixture below, stdout+rc
//   recorded verbatim. Normalization: NONE — the output is static (no timings/log
//   paths); the two lines that vary across runs are pinned deterministically:
//     * "▸ s2-agent processes: N"  — N=0 via a PATH stub `ps` (emits nothing,
//       exit 0), so the line is stable on any machine with no live s2-agent.
//     * commit-mode timestamp TS (backup + manifest names) — a PATH stub `date`
//       emitting `20260823T000000` for `date +%Y%m%dT%H%M%S` (what dedup.sh
//       calls), so the goldens name the exact files the run produced.
//   The fixture is reseeded from these same fixed /tmp paths before each run, so
//   every byte of the goldens (incl. store-dir/backup/manifest paths) is
//   reproducible in the test itself.
//
// Contract notes (measured, not assumed):
//   * dedup.sh has NO `--dry-run` flag — dry-run IS the default. Passing
//     `--dry-run` exits 2 "unknown arg" (pinned by the `unknown-arg` case below);
//     the dry-run goldens were therefore captured without the flag.
//   * The brief's `errIncludes: ["usage"]` could never match: dedup.sh's usage
//     errors say "invalid --target ..." / "unknown arg: ... (try --help)"; the
//     cases assert the real raw-stderr substrings instead.
//
// DB internals are NOT pinned (D5: `bun:sqlite` is free to differ from the
// sqlite3 CLI) — the fixture schema (memories + trigger-mirrored memory_fts) is
// designed so the script's FTS integrity check passes after a commit.

import { test, beforeAll, afterAll } from "bun:test";
import { assertParity } from "../../tests/helpers/bash-parity"; // bun-apps/tests/helpers (two levels up: pkg/tests -> bun-apps)
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The dedup.ts path is package-relative (spawned via `bun skills/.../dedup.ts`
// from the package root — the contract in the plan). Resolve the package root
// from this test file's own URL so the test works from any cwd.
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEDUP = "skills/memory-bulk-dedup/dedup.ts";

// Fixed /tmp paths — NOT `node:os tmpdir()` (which honors $TMPDIR =
// /var/folders/... on macOS and would move the store dir off the goldens). The
// goldens embed these literals (store dir, backup + manifest names) — dedup.sh's
// store dir resolves LOGICALLY (`cd dirname && pwd`), so /tmp stays /tmp.
const FIXTURE = "/tmp/dedup-fixture";
const FIXTURE_COMMIT = "/tmp/dedup-fixture-commit";
const STUB_DIR = "/tmp/dedup-stub";
const DB_PATH = join(FIXTURE, "db.sqlite");
const DB_PATH_COMMIT = join(FIXTURE_COMMIT, "db.sqlite");

// Stubbed PATH: `ps` emits nothing (-> count 0), `date` is pinned. The old
// capture ran under the same stub, so goldens and test bytes agree on any host.
function stubEnv(): { PATH: string } {
  return { PATH: `${STUB_DIR}:${process.env.PATH ?? ""}` };
}

// ── fixture content (same as the capture seed; 7 failure rows + 2 cross-target) ─
const C3 =
  "[failure] lesson: never run git rev-parse --is-inside-work-tree inside a detached head hook because it returns true and misleads the exit code logic";
const C4 = C3.slice(0, 80) +
  " - VARIANT: with a shallow clone the same trick stops publishing tags and the guard was added later in the runbook";
const C6 =
  "[failure] lesson: after a rebase, bundle exec nuke leaves stale tags and the next push fails with 403 until you recreate the remote ref via git push origin --tags --force";

const SEED_SQL = `
CREATE TABLE memories (id INTEGER PRIMARY KEY, target TEXT, content TEXT NOT NULL, category TEXT);
CREATE TABLE memory_fts (rowid INTEGER PRIMARY KEY, content TEXT NOT NULL);
CREATE TRIGGER memories_ai AFTER INSERT ON memories
  BEGIN INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content); END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories
  BEGIN DELETE FROM memory_fts WHERE rowid = old.id; END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories
  BEGIN UPDATE memory_fts SET content = new.content WHERE rowid = new.id; END;
INSERT INTO memories (id, target, content) VALUES
  (1, 'failure', '[failure] [bash error] sqlite3: command not found'),
  (2, 'failure', '[REMOVED] obsolete entry'),
  (3, 'failure', '${C3}'),
  (4, 'failure', '${C4}'),
  (5, 'failure', '[failure] lesson: memory add rejects a target once its in-process capacity counter is full even though the db row count is low; the counter lags until the harness reloads from disk'),
  (6, 'failure', '${C6}'),
  (7, 'failure', '${C6}'),
  (8, 'memory', '[memory] cross-target sentinel row'),
  (9, 'user', '[user] cross-target sentinel row');
`;

function mdEntries(contents: string[], dates: string[]): string {
  return contents
    .map((c, i) => `${c} <!-- created=${dates[i]}, last=${dates[i]} -->`)
    .join("\n§\n") + "\n";
}

function ensureFixture(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "db.sqlite"));
  db.exec(SEED_SQL);
  db.close();
  // 7 failure entries (ids 1-7), metadata comments appended like the real .md.
  const md = mdEntries(["[failure] [bash error] sqlite3: command not found", "[REMOVED] obsolete entry", C3, C4,
    "[failure] lesson: memory add rejects a target once its in-process capacity counter is full even though the db row count is low; the counter lags until the harness reloads from disk", C6, C6],
    ["2026-08-18", "2026-08-18", "2026-08-19", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-21"]);
  writeFileSync(join(dir, "failures.md"), md);
}

function ensureStubs(): void {
  rmSync(STUB_DIR, { recursive: true, force: true });
  mkdirSync(STUB_DIR, { recursive: true });
  writeFileSync(join(STUB_DIR, "ps"), "#!/bin/sh\nexit 0\n"); // stub ps: zero processes
  writeFileSync(join(STUB_DIR, "date"), "#!/bin/sh\necho 20260823T000000\n"); // fixed dedup TS
  chmodSync(join(STUB_DIR, "ps"), 0o755);
  chmodSync(join(STUB_DIR, "date"), 0o755);
}

beforeAll(() => {
  ensureStubs();
  ensureFixture(FIXTURE);
  ensureFixture(FIXTURE_COMMIT);
});
afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
  rmSync(FIXTURE_COMMIT, { recursive: true, force: true });
  rmSync(STUB_DIR, { recursive: true, force: true });
});

// ── goldens (verbatim from dedup.sh@072bfaa8, captured 2026-08-23) ────────────

const HELP_GOLDEN = `# dedup.sh — deterministic bulk-dedup of one pi-memory target.
#
# Automates the memory-bulk-dedup SKILL.md procedure so each run is
# reproducible instead of re-derived by hand. Pure bash + sqlite3 (no deps).
#
# SAFETY MODEL (two-tier):
#   HARD-DELETE (applied with --commit):  exact-content duplicates + explicit
#     tombstones ([REMOVED …] / [MERGED-PLACEHOLDER-*]). These lose nothing —
#     exact dups are byte-identical re-inserts; tombstones are garbage by def.
#   REPORT-ONLY (never auto-deleted):     near-dup clusters, short/[bash error]
#     stubs. These may encode real lessons, so they are PRINTED for a human.
#     Add --prune-stubs to ALSO delete stub rows (review the dry-run first).
#
# USAGE:
#   bash dedup.sh                                 # dry-run, target=failure
#   bash dedup.sh --target memory                 # dry-run, target=memory
#   bash dedup.sh --commit                        # APPLY hard-deletes (failure)
#   bash dedup.sh --prune-stubs --commit          # also remove stub rows
#   bash dedup.sh --target failure --commit --keep-backups 5
#
# The default is DRY-RUN — it prints the full plan and deletes nothing.
# --commit always backs up + checkpoints WAL before any DELETE, and writes a
# recoverable manifest of every removed row.
#
# PATH PORTABILITY: this script may live in a repo worktree, a bundled
# (--bundle) deploy, or an extracted (--exe) binary cache — so it NEVER derives
# store paths from its own location. Every store artifact (sessions.db, the
# per-target .md sources, timestamped backups, the cross-process .md.lock, and
# the .tsv manifest) resolves under the agent-root memory dir:
#   \${PI_CODING_AGENT_DIR:-\$HOME/.pi/agent}/pi-hermes-memory/`;

const DRYRUN_GOLDEN = `▸ s2-agent processes: 0  (race risk if another session writes the DB mid-run)
▸ store dir: /tmp/dedup-fixture
▸ target='failure'  rows=7  chars=935
▸ mode=DRY-RUN  prune-stubs=0

── HARD-DELETE (safe: exact dups + tombstones) ─────────────────────────
  del id=6      len=170   [failure] lesson: after a rebase, bundle exec nuke leaves stale tags and
  del id=2      len=24    [REMOVED] obsolete entry

── STUBS (report-only) ──
  id=2      len=24    [REMOVED] obsolete entry
  id=1      len=49    [failure] [bash error] sqlite3: command not found

── NEAR-DUP clusters (report-only — shared first 80 chars) ─────
  cluster(2 rows) ids=6,7 : [failure] lesson: after a rebase, bundle exec nuke leaves stale tags and the nex
  cluster(2 rows) ids=3,4 : [failure] lesson: never run git rev-parse --is-inside-work-tree inside a detache

▸ projection: 7 → 5 rows  (2 deleted)
  (stubs NOT deleted — add --prune-stubs to remove 2 more)

▸ DRY-RUN — nothing deleted. Re-run with --commit to apply hard-deletes.`;

const DRYRUN_PRUNE_GOLDEN = `▸ s2-agent processes: 0  (race risk if another session writes the DB mid-run)
▸ store dir: /tmp/dedup-fixture
▸ target='failure'  rows=7  chars=935
▸ mode=DRY-RUN  prune-stubs=1

── HARD-DELETE (safe: exact dups + tombstones) ─────────────────────────
  del id=6      len=170   [failure] lesson: after a rebase, bundle exec nuke leaves stale tags and
  del id=2      len=24    [REMOVED] obsolete entry

── STUBS (report-only → WILL DELETE with --prune-stubs) ──
  id=2      len=24    [REMOVED] obsolete entry
  id=1      len=49    [failure] [bash error] sqlite3: command not found

── NEAR-DUP clusters (report-only — shared first 80 chars) ─────
  cluster(2 rows) ids=6,7 : [failure] lesson: after a rebase, bundle exec nuke leaves stale tags and the nex
  cluster(2 rows) ids=3,4 : [failure] lesson: never run git rev-parse --is-inside-work-tree inside a detache

▸ projection: 7 → 4 rows  (3 deleted)

▸ DRY-RUN — nothing deleted. Re-run with --commit to apply hard-deletes + stubs.`;

const DRYRUN_PREFIX40_GOLDEN = `▸ s2-agent processes: 0  (race risk if another session writes the DB mid-run)
▸ store dir: /tmp/dedup-fixture
▸ target='failure'  rows=7  chars=935
▸ mode=DRY-RUN  prune-stubs=0

── HARD-DELETE (safe: exact dups + tombstones) ─────────────────────────
  del id=6      len=170   [failure] lesson: after a rebase, bundle exec nuke leaves stale tags and
  del id=2      len=24    [REMOVED] obsolete entry

── STUBS (report-only) ──
  id=2      len=24    [REMOVED] obsolete entry
  id=1      len=49    [failure] [bash error] sqlite3: command not found

── NEAR-DUP clusters (report-only — shared first 40 chars) ─────
  cluster(2 rows) ids=6,7 : [failure] lesson: after a rebase, bundle
  cluster(2 rows) ids=3,4 : [failure] lesson: never run git rev-pars

▸ projection: 7 → 5 rows  (2 deleted)
  (stubs NOT deleted — add --prune-stubs to remove 2 more)

▸ DRY-RUN — nothing deleted. Re-run with --commit to apply hard-deletes.`;

const COMMIT_GOLDEN = `▸ s2-agent processes: 0  (race risk if another session writes the DB mid-run)
▸ store dir: /tmp/dedup-fixture-commit
▸ target='failure'  rows=7  chars=935
▸ mode=COMMIT  prune-stubs=0

── HARD-DELETE (safe: exact dups + tombstones) ─────────────────────────
  del id=6      len=170   [failure] lesson: after a rebase, bundle exec nuke leaves stale tags and
  del id=2      len=24    [REMOVED] obsolete entry

── STUBS (report-only) ──
  id=2      len=24    [REMOVED] obsolete entry
  id=1      len=49    [failure] [bash error] sqlite3: command not found

── NEAR-DUP clusters (report-only — shared first 80 chars) ─────
  cluster(2 rows) ids=6,7 : [failure] lesson: after a rebase, bundle exec nuke leaves stale tags and the nex
  cluster(2 rows) ids=3,4 : [failure] lesson: never run git rev-parse --is-inside-work-tree inside a detache

▸ projection: 7 → 5 rows  (2 deleted)
  (stubs NOT deleted — add --prune-stubs to remove 2 more)
▸ backup (db): /tmp/dedup-fixture-commit/db.sqlite.bak-dedup-20260823T000000
▸ .md source trim: 7 -> 6 §-entries (removed 1) [failures.md]
▸ manifest: /tmp/dedup-fixture-commit/dedup-removed-failure-20260823T000000.tsv
▸ AFTER: rows=5  chars=741  (removed 2 rows, 194 chars)
▸ FTS: orphans=0  (must be 0)   memory_fts=7  memories=7  (must match)
▸ done. (note: a running agent's in-memory capacity counter may stay stale until restart — the on-disk DB is clean.)`;

// ── the parity cases ─────────────────────────────────────────────────────────

test("dedup.ts help", () => {
  assertParity(DEDUP, [
    { name: "help", args: ["--help"], cwd: PKG_DIR, env: stubEnv(), expectCode: 0, out: HELP_GOLDEN },
  ]);
});

test("dedup.ts dry-run BEFORE→AFTER", () => {
  assertParity(DEDUP, [
    {
      name: "dry-run",
      args: ["--target", "failure", "--db", DB_PATH],
      cwd: PKG_DIR, env: stubEnv(), expectCode: 0, out: DRYRUN_GOLDEN,
    },
  ]);
});

test("dedup.ts dry-run --prune-stubs (projection extends to stubs)", () => {
  assertParity(DEDUP, [
    {
      name: "dry-run-prune-stubs",
      args: ["--target", "failure", "--db", DB_PATH, "--prune-stubs"],
      cwd: PKG_DIR, env: stubEnv(), expectCode: 0, out: DRYRUN_PRUNE_GOLDEN,
    },
  ]);
});

test("dedup.ts dry-run --prefix-len 40 (near-dup key resized)", () => {
  assertParity(DEDUP, [
    {
      name: "dry-run-prefix-len-40",
      args: ["--target", "failure", "--db", DB_PATH, "--prefix-len", "40"],
      cwd: PKG_DIR, env: stubEnv(), expectCode: 0, out: DRYRUN_PREFIX40_GOLDEN,
    },
  ]);
});

test("dedup.ts commit on a copy", () => {
  ensureFixture(FIXTURE_COMMIT); // destructive by design — fresh copy per run
  assertParity(DEDUP, [
    {
      name: "commit",
      args: ["--target", "failure", "--db", DB_PATH_COMMIT, "--commit", "--keep-backups", "1"],
      cwd: PKG_DIR, env: stubEnv(), expectCode: 0, out: COMMIT_GOLDEN,
    },
  ]);
});

test("dedup.ts bogus target exits 2 (usage error)", () => {
  assertParity(DEDUP, [
    {
      name: "usage-error",
      args: ["--target", "bogus-name", "--db", DB_PATH],
      cwd: PKG_DIR, env: stubEnv(), expectCode: 2,
      errIncludes: ["invalid --target 'bogus-name' (memory|user|failure)"],
    },
  ]);
});

test("dedup.ts unknown flag exits 2 (--dry-run is NOT a flag)", () => {
  assertParity(DEDUP, [
    {
      name: "unknown-arg",
      args: ["--dry-run"],
      cwd: PKG_DIR, env: stubEnv(), expectCode: 2,
      errIncludes: ["unknown arg: --dry-run (try --help)"],
    },
  ]);
});
