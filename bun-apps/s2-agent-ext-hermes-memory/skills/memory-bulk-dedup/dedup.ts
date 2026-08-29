// dedup.ts — deterministic bulk-dedup of one pi-memory target.
//
// Portable Bun twin of the former dedup.sh (same dir). Automates the
// memory-bulk-dedup SKILL.md procedure so each run is reproducible instead
// of re-derived by hand. Bun-only (no deps; DB via bun:sqlite).
//
// SAFETY MODEL (two-tier):
//   HARD-DELETE (applied with --commit):  exact-content duplicates + explicit
//     tombstones ([REMOVED …] / [MERGED-PLACEHOLDER-*]). These lose nothing —
//     exact dups are byte-identical re-inserts; tombstones are garbage by def.
//   REPORT-ONLY (never auto-deleted):     near-dup clusters, short/[bash error]
//     stubs. These may encode real lessons, so they are PRINTED for a human.
//     Add --prune-stubs to ALSO delete stub rows (review the dry-run first).
//
// USAGE:
//   bun dedup.ts                                  # dry-run, target=failure
//   bun dedup.ts --target memory                  # dry-run, target=memory
//   bun dedup.ts --commit                         # APPLY hard-deletes (failure)
//   bun dedup.ts --prune-stubs --commit           # also remove stub rows
//   bun dedup.ts --target failure --commit --keep-backups 5
//
// The default is DRY-RUN — it prints the full plan and deletes nothing.
// --commit always backs up + checkpoints WAL before any DELETE, and writes a
// recoverable manifest of every removed row.
//
// PATH PORTABILITY: like dedup.sh, this script may live in a repo worktree, a
// bundled (--bundle) deploy, or an extracted (--exe) binary cache — so it NEVER
// derives store paths from its own location. Every store artifact (sessions.db,
// the per-target .md sources, timestamped backups, the cross-process .md.lock,
// and the .tsv manifest) resolves under the agent-root memory dir:
//   ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-hermes-memory/
//
// PARITY CONTRACT (golden-pinned by tests/dedup-parity.test.ts, captured from
// dedup.sh@072bfaa8): stdout lines + exit codes byte-identical to dedup.sh.
// DB internals are free to differ (bun:sqlite vs the sqlite3 CLI) — the one
// deliberate divergence: the old bash `command -v sqlite3` preflight is gone
// (bun:sqlite is built in — the script no longer shells out to sqlite3).

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

// Agent-root memory dir — portable default for ALL store files (DB + .md +
// backups + lock + .tsv). Works from any install location of this script.
const MEM_DIR_DEFAULT = `${process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`}/pi-hermes-memory`;
let DB = process.env.PI_MEMORY_DB ?? `${MEM_DIR_DEFAULT}/sessions.db`;
let TARGET = "failure";
let COMMIT = 0; // 0 = dry-run (default), 1 = apply
let PRUNE_STUBS = 0;
let PREFIX_LEN = 80; // near-dup cluster key length (report only)
let STUB_MAXLEN = 120; // rows shorter than this are "stubs" (report / --prune-stubs)
let KEEP_BACKUPS = 5; // retain newest N dedup/consolidate backups

// Hardcoded help payload — byte-identical to dedup.sh's usage() output
// (the comment block above, extracted by its sed chain). Keep in sync by
// running `bun dedup.ts --help` vs the recorded golden.
const HELP = `# dedup.sh — deterministic bulk-dedup of one pi-memory target.
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

// ── arg parsing (identical flag set + error messages to dedup.sh) ────────────
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--target": TARGET = argv[++i] ?? ""; break;
    case "--db": DB = argv[++i] ?? ""; break;
    case "--prefix-len": PREFIX_LEN = argv[++i] ?? ""; break;
    case "--stub-maxlen": STUB_MAXLEN = argv[++i] ?? ""; break;
    case "--keep-backups": KEEP_BACKUPS = argv[++i] ?? ""; break; // (string; used in arithmetic like bash)
    case "--commit": COMMIT = 1; break;
    case "--prune-stubs": PRUNE_STUBS = 1; break;
    case "-h":
    case "--help":
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    default:
      console.error(`unknown arg: ${a} (try --help)`);
      process.exit(2);
  }
}

// Whitelist target (also a SQL-injection guard — TARGET is interpolated below).
if (TARGET !== "memory" && TARGET !== "user" && TARGET !== "failure") {
  console.error(`invalid --target '${TARGET}' (memory|user|failure)`);
  process.exit(2);
}
if (!existsSync(DB)) {
  console.error(`DB not found: ${DB}`);
  process.exit(1);
}

// Resolve the memory dir as the DB's directory. The DB exists (checked above)
// so its dir exists too. The .md source files, timestamped backups, the
// cross-process .md.lock, and the .tsv manifest ALL resolve under HERE — never
// next to this script (which may live in a read-only bundle/exe cache). --db
// therefore relocates the whole co-located store set, not just the .db file.
// NOTE: like bash's `cd $(dirname "$DB") && pwd` (logical -L), this does NOT
// follow symlinks — so /tmp stays `/tmp` on macOS, never /private/tmp.
const MEM_DIR = resolve(dirname(DB));

const db = new Database(DB);

// ── concurrency: warn (not block) if other s2-agent sessions are live ────────
// Same probe as dedup.sh: ps aux filter (case-insensitive) on BOTH legacy
// `pi-coding-agent` AND the current runtime `bun …/s2-agent/src/cli.ts`, minus
// the grep / dedup.sh self lines. (The stub `ps` shims in the parity test make
// this 0 deterministically.)
let piCount = 0;
{
  let out = "";
  try {
    const r = spawnSync("ps", ["aux"], { encoding: "utf8" });
    if (r.error) throw r.error;
    out = r.stdout ?? "";
  } catch {
    out = ""; // ps unavailable: behave as no matching processes (old: grep got empty input)
  }
  piCount = out
    .split("\n")
    .filter((l) => l !== "" &&
      (l.toLowerCase().includes("pi-coding-agent") || l.toLowerCase().includes("s2-agent/src/cli")) &&
      !l.includes("grep") && !l.includes("dedup.sh"))
    .length;
}

console.log(`▸ s2-agent processes: ${piCount}  (race risk if another session writes the DB mid-run)`);
console.log(`▸ store dir: ${MEM_DIR}`);
if (COMMIT === 1 && piCount > 1) {
  console.error("  ℹ multiple s2-agent processes detected — the .md-trim below is now cross-process-locked (Workstream B), so a live session's write can't clobber it. DB hydration / a session's in-memory cache may still lag until it reloads.");
}

const q = (sql: string) => db.query(sql).all();
const q1 = (sql: string) => db.query(sql).get();

const BEFORE = Number((q1(`SELECT COUNT(*) AS n FROM memories WHERE target='${TARGET}';`) as { n: number }).n);
const BEFORE_CHARS = Number((q1(`SELECT COALESCE(sum(length(content)),0) AS n FROM memories WHERE target='${TARGET}';`) as { n: number }).n);
console.log(`▸ target='${TARGET}'  rows=${BEFORE}  chars=${BEFORE_CHARS}`);
console.log(`▸ mode=${COMMIT === 1 ? "COMMIT" : "DRY-RUN"}  prune-stubs=${PRUNE_STUBS}`);
console.log();

// ── 1. HARD-DELETE candidates: exact-content dup losers + tombstones ─────────
const HARD_SQL = `WITH tombstones AS (
  SELECT id FROM memories WHERE target='${TARGET}'
    AND (content LIKE '[REMOVED%' OR content LIKE 'REMOVED —%'
         OR content LIKE '[MERGED-PLACEHOLDER%')
),
dup_losers AS (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY content ORDER BY length(content) DESC, id DESC) AS rn
    FROM memories WHERE target='${TARGET}'
  ) WHERE rn > 1
)
SELECT m.id, length(m.content) AS L,
       substr(replace(replace(m.content,char(10),' '),char(13),' '),1,72) AS preview
FROM (SELECT id FROM tombstones UNION SELECT id FROM dup_losers) d
JOIN memories m ON m.id=d.id ORDER BY L DESC;`;

console.log("── HARD-DELETE (safe: exact dups + tombstones) ─────────────────────────");
const hardRows = q(HARD_SQL) as { id: number; L: number; preview: string }[];
const hardIds = hardRows.map((r) => r.id);
if (hardRows.length > 0) {
  for (const r of hardRows) {
    console.log(`  del id=${String(r.id).padEnd(6)} len=${String(r.L).padEnd(5)} ${r.preview}`);
  }
} else {
  console.log("  (none)");
}
const HARD_N = hardRows.length;
console.log();

// ── 2. STUB candidates: [bash error] prefix or very short (report-only) ─────
const STUB_SQL = `SELECT id, length(content) AS L,
       substr(replace(replace(content,char(10),' '),char(13),' '),1,72) AS preview
FROM memories WHERE target='${TARGET}'
  AND (content LIKE '[bash error]%' OR content LIKE '[failure] [bash error]%'
       OR length(content) < ${STUB_MAXLEN})
ORDER BY L ASC;`;
console.log(`── STUBS (report-only${PRUNE_STUBS === 1 ? " → WILL DELETE with --prune-stubs" : ""}) ──`);
const stubRows = q(STUB_SQL) as { id: number; L: number; preview: string }[];
const stubIds = stubRows.map((r) => r.id);
if (stubRows.length > 0) {
  for (const r of stubRows) {
    console.log(`  id=${String(r.id).padEnd(6)} len=${String(r.L).padEnd(5)} ${r.preview}`);
  }
} else {
  console.log("  (none)");
}
const STUB_N = stubRows.length;
console.log();

// ── 3. NEAR-DUP report: shared content-prefix, different full content ───────
const NEAR_SQL = `SELECT cnt, cluster, ids FROM (
  SELECT substr(content,1,${PREFIX_LEN}) AS cluster, COUNT(*) AS cnt,
         group_concat(id) AS ids
  FROM memories WHERE target='${TARGET}'
  GROUP BY substr(content,1,${PREFIX_LEN}) HAVING COUNT(*) > 1
) ORDER BY cnt DESC;`;
console.log(`── NEAR-DUP clusters (report-only — shared first ${PREFIX_LEN} chars) ─────`);
const nearRows = q(NEAR_SQL) as { cnt: number; cluster: string; ids: string }[];
if (nearRows.length > 0) {
  for (const r of nearRows) {
    console.log(`  cluster(${r.cnt} rows) ids=${r.ids} : ${r.cluster}`);
  }
} else {
  console.log(`  (none — every prefix-${PREFIX_LEN} is unique)`);
}
console.log();

// ── projection ──────────────────────────────────────────────────────────────
// Union of hard-delete ids + (with --prune-stubs) stub ids — sorted -n, de-dup
// — exactly the old `sort -n | awk NF | sort -u | wc -l` pipeline.
const delSet = new Set<number>(hardIds);
if (PRUNE_STUBS === 1) for (const i of stubIds) delSet.add(i);
const delIds = [...delSet].sort((a, b) => a - b);
const DEL_N = delIds.length;
const AFTER = BEFORE - DEL_N;
console.log(`▸ projection: ${BEFORE} → ${AFTER} rows  (${DEL_N} deleted)`);
if (PRUNE_STUBS === 0 && STUB_N > 0) {
  console.log(`  (stubs NOT deleted — add --prune-stubs to remove ${STUB_N} more)`);
}

// ── dry-run stops here ──────────────────────────────────────────────────────
if (COMMIT === 0) {
  console.log();
  console.log(`▸ DRY-RUN — nothing deleted. Re-run with --commit to apply hard-deletes${PRUNE_STUBS === 1 ? " + stubs" : ""}.`);
  process.exit(0);
}

// ── COMMIT: backup → checkpoint → manifest → delete → verify ─────────────────
// Same `date +%Y%m%dT%H%M%S` format as dedup.sh (local time; the parity test
// pins it with a `date` stub). Falls back to a JS-computed local timestamp only
// if `date` is missing from PATH.
const TS = ((): string => {
  const r = spawnSync("date", ["+%Y%m%dT%H%M%S"], { encoding: "utf8" });
  if (!r.error && r.status === 0) return (r.stdout ?? "").trim();
  const d = new Date();
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const BAK = `${DB}.bak-dedup-${TS}`;
copyFileSync(DB, BAK);
console.log(`▸ backup (db): ${BAK}`);
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

// Manifest lives next to the DB (under the agent-root memory dir), NOT beside
// this script — so a bundled/exe install never writes into a read-only package.
const MANIFEST = `${MEM_DIR}/dedup-removed-${TARGET}-${TS}.tsv`;
writeFileSync(MANIFEST, "id\tcategory\tlength\tpreview\n");

// ── trim the SOURCE-OF-TRUTH .md (DB-only delete re-hydrates; .md is source) ─
// failure→failures.md, memory→MEMORY.md, user→USER.md (§-delimited entries).
// MEM_DIR (= DB's dir) already resolved above — .md lives alongside the DB.
// The §-filter below is ported verbatim from dedup.sh's embedded python — same
// split/prefix/trailing-separator semantics, do not redesign.
const MDFILE =
  TARGET === "failure" ? `${MEM_DIR}/failures.md` :
  TARGET === "memory" ? `${MEM_DIR}/MEMORY.md` :
  `${MEM_DIR}/USER.md`;
if (existsSync(MDFILE)) {
  // ── cross-process .md lock (Workstream B) ────────────────────────────────
  // MemoryStore wraps loadFromDisk→saveToDisk in a proper-lockfile advisory
  // lock whose lockfile is a DIRECTORY `<mdPath>.lock` (mtime-proven liveness,
  // stale after 10s). Acquire the SAME directory lock here so this trim can't
  // race a live session's write (lost-update). Acquire retries — a session
  // write is sub-second; a holder stuck >10s is stale (crashed) and gets broken.
  const LOCK = `${MDFILE}.lock`;
  let _tries = 0;
  let locked = false;
  while (!locked) {
    try {
      mkdirSync(LOCK);
      locked = true;
      break;
    } catch {
      _tries++;
      if (_tries > 200) {
        console.error("  ⚠ .md lock held >20s by another process — aborting trim to avoid a lost-update race.");
        console.error(`    DB rows NOT deleted. Re-run dedup when no session is mid-write (or after restart). Backup: ${BAK}`);
        process.exit(1);
      }
      if (existsSync(LOCK)) {
        let mtime = 0;
        try {
          mtime = Math.floor(statSync(LOCK).mtimeMs / 1000);
        } catch {
          mtime = 0;
        }
        if (Math.floor(Date.now() / 1000) - mtime >= 10) {
          try {
            rmdirSync(LOCK);
          } catch {
            rmSync(LOCK, { recursive: true, force: true });
          }
          continue;
        }
      }
      // sleep 0.1 (synchronous — mirrors bash's `sleep 0.1` in the retry loop)
      Atomics.wait(SLEEP_BUF, 0, 0, 100);
    }
  }

  try {
    // verbatim of dedup.sh's embedded python:
    //   rows = SELECT content FROM memories WHERE target=?
    //   md_cand / prefixes / parts / removed / kept / trailing-"§" fix
    const contents = (db.query(`SELECT content FROM memories WHERE target='${TARGET}';`).all() as { content: string }[]).map((r) => r.content);
    const mdCand = (c: string): boolean =>
      c.startsWith("[REMOVED") || c.startsWith("[MERGED-PLACEHOLDER") || c.startsWith("REMOVED —") ||
      (PRUNE_STUBS === 1 && (c.startsWith("[bash error]") || c.startsWith("[failure] [bash error]") || c.length < Number(STUB_MAXLEN)));
    const prefixes = new Set<string>();
    for (const c of contents) if (mdCand(c)) prefixes.add(c.slice(0, 60));

    const p = MDFILE;
    copyFileSync(p, `${p}.bak-md-${Math.floor(Date.now() / 1000)}`);
    const text = readFileSync(p, "utf8");
    const parts = text.split("\n§\n");
    const startsWithPrefix = (e: string): boolean => {
      const le = e.replace(/^\s+/, "");
      return [...prefixes].some((x) => le.startsWith(x));
    }
    const removed = parts.filter(startsWithPrefix);
    const kept = parts.filter((e) => !startsWithPrefix(e));
    let newText = kept.join("\n§\n");
    // python: if not text.rstrip().endswith("§") and new.rstrip().endswith("§"): new = new.rstrip()[:-1]
    if (!text.replace(/\s+$/, "").endsWith("§") && newText.replace(/\s+$/, "").endsWith("§")) {
      newText = newText.replace(/\s+$/, "").slice(0, -1);
    }
    writeFileSync(p, newText);
    for (const e of removed) {
      writeFileSync(MANIFEST, `MD-entry\t${e.replace(/\n/g, " ").slice(0, 120)}\n`, { flag: "a" });
    }
    console.log(`▸ .md source trim: ${parts.length} -> ${kept.length} §-entries (removed ${removed.length}) [${basename(p)}]`);
  } finally {
    try {
      rmdirSync(`${MDFILE}.lock`);
    } catch {
      rmSync(`${MDFILE}.lock`, { recursive: true, force: true });
    }
  }
} else {
  // Kept byte-identical to dedup.sh's warning (stderr, unpinned by goldens):
  // the .ts twin needs no python3, but wording parity is the safer contract.
  console.error(`  ⚠ python3 or ${MDFILE} missing — .md NOT trimmed; DB deletes WILL re-hydrate. Trim ${MDFILE} manually.`);
}

// append DB rows being deleted to the manifest (same order as old `sort -n | sort -u`)
for (const rid of delIds) {
  const row = db.query(
    `SELECT id, COALESCE(category,'') AS cat, length(content) AS L,
       substr(replace(replace(content,char(10),' '),char(13),' '),1,90) AS preview
     FROM memories WHERE id=${rid};`,
  ).get() as { id: number; cat: string; L: number; preview: string };
  writeFileSync(MANIFEST, `${row.id}\t${row.cat}\t${row.L}\t${row.preview}\n`, { flag: "a" });
}
console.log(`▸ manifest: ${MANIFEST}`);

// DELETE via WITH-clause (re-derives the sets transactionally).
const PRUNE_CLAUSE = PRUNE_STUBS === 1
  ? `, stubs AS (SELECT id FROM memories WHERE target='${TARGET}' AND (content LIKE '[bash error]%' OR content LIKE '[failure] [bash error]%' OR length(content) < ${STUB_MAXLEN}))`
  : "";
db.exec(`BEGIN;
WITH tombstones AS (
  SELECT id FROM memories WHERE target='${TARGET}'
    AND (content LIKE '[REMOVED%' OR content LIKE 'REMOVED —%' OR content LIKE '[MERGED-PLACEHOLDER%')
),
dup_losers AS (
  SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY content ORDER BY length(content) DESC, id DESC) rn FROM memories WHERE target='${TARGET}') WHERE rn > 1
)${PRUNE_CLAUSE}
DELETE FROM memories WHERE id IN (
  SELECT id FROM tombstones UNION SELECT id FROM dup_losers${PRUNE_STUBS === 1 ? " UNION SELECT id FROM stubs" : ""}
);
COMMIT;`);

// ── verify FTS integrity ────────────────────────────────────────────────────
const AFTER_N = Number((q1(`SELECT COUNT(*) AS n FROM memories WHERE target='${TARGET}';`) as { n: number }).n);
const AFTER_CHARS = Number((q1(`SELECT COALESCE(sum(length(content)),0) AS n FROM memories WHERE target='${TARGET}';`) as { n: number }).n);
const orphans = Number((q1("SELECT COUNT(*) AS n FROM memory_fts f LEFT JOIN memories m ON m.id=f.rowid WHERE m.id IS NULL;") as { n: number }).n);
const ftsTotal = Number((q1("SELECT COUNT(*) AS n FROM memory_fts;") as { n: number }).n);
const memTotal = Number((q1("SELECT COUNT(*) AS n FROM memories;") as { n: number }).n);
console.log(`▸ AFTER: rows=${AFTER_N}  chars=${AFTER_CHARS}  (removed ${BEFORE - AFTER_N} rows, ${BEFORE_CHARS - AFTER_CHARS} chars)`);
console.log(`▸ FTS: orphans=${orphans}  (must be 0)   memory_fts=${ftsTotal}  memories=${memTotal}  (must match)`);
if (orphans !== 0 || ftsTotal !== memTotal) {
  console.error(`  ⚠ FTS INTEGRITY CHECK FAILED — restore from ${BAK}`);
  process.exit(1);
}

// ── prune old backups (keep newest KEEP_BACKUPS of dedup/consolidate) ────────
// Same semantics as `ls -1t "$DB".bak-dedup-* "$DB".bak-consolidate-*` (mtime
// desc, keep newest N).
const fname = basename(DB);
const backups = readdirSync(MEM_DIR)
  .filter((f) => f.startsWith(`${fname}.bak-dedup-`) || f.startsWith(`${fname}.bak-consolidate-`))
  .map((f) => ({ name: f, mtime: statSync(resolve(MEM_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
const pruned = backups.slice(Number(KEEP_BACKUPS));
if (pruned.length > 0) {
  for (const p of pruned) rmSync(resolve(MEM_DIR, p.name), { force: true });
  console.log(`▸ pruned ${pruned.length} old backup(s) (kept newest ${KEEP_BACKUPS})`);
}
console.log("▸ done. (note: a running agent's in-memory capacity counter may stay stale until restart — the on-disk DB is clean.)");
