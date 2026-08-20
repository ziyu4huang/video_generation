#!/usr/bin/env bash
# dedup.sh — deterministic bulk-dedup of one pi-memory target.
#
# Automates the pi-memory-bulk-dedup SKILL.md procedure so each run is
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
#   ${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-hermes-memory/
# --db / $PI_MEMORY_DB relocate the DB (and, because the .md sources live
# alongside it, the whole store set) — matching the original co-location
# invariant that DB + .md must share a directory.
set -euo pipefail

# Agent-root memory dir — portable default for ALL store files (DB + .md +
# backups + lock + .tsv). Works from any install location of this script.
MEM_DIR_DEFAULT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-hermes-memory"
DB="${PI_MEMORY_DB:-$MEM_DIR_DEFAULT/sessions.db}"
TARGET="failure"
COMMIT=0
PRUNE_STUBS=0
PREFIX_LEN=80            # near-dup cluster key length (report only)
STUB_MAXLEN=120          # rows shorter than this are "stubs" (report / --prune-stubs)
KEEP_BACKUPS=5           # retain newest N dedup/consolidate backups
SEP=$'\x1f'              # ASCII unit separator — never appears in content

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//' | sed -n '1,30p'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    --prefix-len) PREFIX_LEN="$2"; shift 2 ;;
    --stub-maxlen) STUB_MAXLEN="$2"; shift 2 ;;
    --keep-backups) KEEP_BACKUPS="$2"; shift 2 ;;
    --commit) COMMIT=1; shift ;;
    --prune-stubs) PRUNE_STUBS=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
done

# Whitelist target (also a SQL-injection guard — TARGET is interpolated below).
case "$TARGET" in memory|user|failure) ;; *) echo "invalid --target '$TARGET' (memory|user|failure)" >&2; exit 2 ;; esac
command -v sqlite3 >/dev/null || { echo "sqlite3 not found in PATH" >&2; exit 1; }
[ -f "$DB" ] || { echo "DB not found: $DB" >&2; exit 1; }

# Resolve the memory dir as the DB's directory (canonicalized). The DB exists
# (checked above) so its dir exists too. The .md source files, timestamped
# backups, the cross-process .md.lock, and the .tsv manifest ALL resolve under
# HERE — never next to this script (which may live in a read-only bundle/exe
# cache). --db therefore relocates the whole co-located store set, not just
# the .db file.
MEM_DIR="$(cd "$(dirname "$DB")" && pwd)"

# ── concurrency: warn (not block) if other s2-agent sessions are live ──
# `|| true` guards the grep pipeline: grep exits 1 on zero matches, which under
# `set -e`+`pipefail` would kill the script before the first echo.
# Match BOTH legacy `pi-coding-agent` AND the current runtime `bun …/s2-agent/src/cli.ts`
# (the latter was UNMATCHED before 2026-07-14 → false-negative "0 processes" while 4
# sessions were live; see failure memory 2026-07-11 + pi-memory-bulk-dedup pitfalls).
pi_count=$( { ps aux | grep -iE 'pi-coding-agent|s2-agent/src/cli' | grep -v grep | grep -v "dedup.sh" || true; } | wc -l | tr -d ' ')
echo "▸ s2-agent processes: $pi_count  (race risk if another session writes the DB mid-run)"
echo "▸ store dir: $MEM_DIR"
if [ "$COMMIT" = 1 ] && [ "$pi_count" -gt 1 ]; then
  echo "  ℹ multiple s2-agent processes detected — the .md-trim below is now cross-process-locked (Workstream B), so a live session's write can't clobber it. DB hydration / a session's in-memory cache may still lag until it reloads." >&2
fi

BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memories WHERE target='$TARGET';")
BEFORE_CHARS=$(sqlite3 "$DB" "SELECT COALESCE(sum(length(content)),0) FROM memories WHERE target='$TARGET';")
echo "▸ target='$TARGET'  rows=$BEFORE  chars=$BEFORE_CHARS"
echo "▸ mode=$([ "$COMMIT" = 1 ] && echo COMMIT || echo DRY-RUN)  prune-stubs=$PRUNE_STUBS"
echo

# ── 1. HARD-DELETE candidates: exact-content dup losers + tombstones ─────────
HARD_SQL=$(cat <<SQL
WITH tombstones AS (
  SELECT id FROM memories WHERE target='$TARGET'
    AND (content LIKE '[REMOVED%' OR content LIKE 'REMOVED —%'
         OR content LIKE '[MERGED-PLACEHOLDER%')
),
dup_losers AS (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY content ORDER BY length(content) DESC, id DESC) AS rn
    FROM memories WHERE target='$TARGET'
  ) WHERE rn > 1
)
SELECT m.id, length(m.content) AS L,
       substr(replace(replace(m.content,char(10),' '),char(13),' '),1,72) AS preview
FROM (SELECT id FROM tombstones UNION SELECT id FROM dup_losers) d
JOIN memories m ON m.id=d.id ORDER BY L DESC;
SQL
)

echo "── HARD-DELETE (safe: exact dups + tombstones) ─────────────────────────"
hard_ids=$( { sqlite3 "$DB" "$HARD_SQL;" || true; } | awk -F'|' '{print $1}')
if [ -n "$hard_ids" ]; then
  sqlite3 -separator "$SEP" "$DB" "$HARD_SQL;" | awk -F"$SEP" '{printf "  del id=%-6s len=%-5s %s\n",$1,$2,$3}'
  hard_n=$(printf '%s\n' "$hard_ids" | wc -l | tr -d ' ')
else
  hard_n=0
  echo "  (none)"
fi
echo

# ── 2. STUB candidates: [bash error] prefix or very short (report-only) ─────
STUB_SQL=$(cat <<SQL
SELECT id, length(content) AS L,
       substr(replace(replace(content,char(10),' '),char(13),' '),1,72) AS preview
FROM memories WHERE target='$TARGET'
  AND (content LIKE '[bash error]%' OR content LIKE '[failure] [bash error]%'
       OR length(content) < $STUB_MAXLEN)
ORDER BY L ASC;
SQL
)
echo "── STUBS (report-only$([ "$PRUNE_STUBS" = 1 ] && echo " → WILL DELETE with --prune-stubs")) ──"
stub_ids=$( { sqlite3 "$DB" "$STUB_SQL;" || true; } | awk -F'|' '{print $1}')
if [ -n "$stub_ids" ]; then
  sqlite3 -separator "$SEP" "$DB" "$STUB_SQL;" | awk -F"$SEP" '{printf "  id=%-6s len=%-5s %s\n",$1,$2,$3}'
  stub_n=$(printf '%s\n' "$stub_ids" | wc -l | tr -d ' ')
else
  stub_n=0
  echo "  (none)"
fi
echo

# ── 3. NEAR-DUP report: shared content-prefix, different full content ───────
NEAR_SQL=$(cat <<SQL
SELECT cnt, cluster, ids FROM (
  SELECT substr(content,1,$PREFIX_LEN) AS cluster, COUNT(*) AS cnt,
         group_concat(id) AS ids
  FROM memories WHERE target='$TARGET'
  GROUP BY substr(content,1,$PREFIX_LEN) HAVING COUNT(*) > 1
) ORDER BY cnt DESC;
SQL
)
echo "── NEAR-DUP clusters (report-only — shared first $PREFIX_LEN chars) ─────"
near=$( { sqlite3 -separator "$SEP" "$DB" "$NEAR_SQL;" || true; })
if [ -n "$near" ]; then
  printf '%s\n' "$near" | awk -F"$SEP" '{printf "  cluster(%s rows) ids=%s : %s\n",$1,$3,$2}'
else
  echo "  (none — every prefix-$PREFIX_LEN is unique)"
fi
echo

# ── projection ──────────────────────────────────────────────────────────────
del_n=$( { [ -n "$hard_ids" ] && printf '%s\n' "$hard_ids"; [ "$PRUNE_STUBS" = 1 ] && [ -n "$stub_ids" ] && printf '%s\n' "$stub_ids"; true; } | sort -n | awk 'NF' | sort -u | wc -l | tr -d ' ')
AFTER=$((BEFORE - del_n))
echo "▸ projection: $BEFORE → $AFTER rows  ($del_n deleted)"
[ "$PRUNE_STUBS" = 0 ] && [ "$stub_n" -gt 0 ] && \
  echo "  (stubs NOT deleted — add --prune-stubs to remove $stub_n more)"

# ── dry-run stops here ──────────────────────────────────────────────────────
if [ "$COMMIT" = 0 ]; then
  echo; echo "▸ DRY-RUN — nothing deleted. Re-run with --commit to apply hard-deletes$([ "$PRUNE_STUBS" = 1 ] && echo " + stubs")."
  exit 0
fi

# ── COMMIT: backup → checkpoint → manifest → delete → verify ─────────────────
TS=$(date +%Y%m%dT%H%M%S)
BAK="$DB.bak-dedup-$TS"
cp "$DB" "$BAK"
echo "▸ backup (db): $BAK"
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null

# Manifest lives next to the DB (under the agent-root memory dir), NOT beside
# this script — so a bundled/exe install never writes into a read-only package.
MANIFEST="$MEM_DIR/dedup-removed-$TARGET-$TS.tsv"
printf 'id\tcategory\tlength\tpreview\n' > "$MANIFEST"

# ── trim the SOURCE-OF-TRUTH .md (DB-only delete re-hydrates; .md is source) ─
# failure→failures.md, memory→MEMORY.md, user→USER.md (§-delimited entries).
# MEM_DIR (= DB's dir) already resolved above — .md lives alongside the DB.
case "$TARGET" in failure) MDFILE="$MEM_DIR/failures.md";; memory) MDFILE="$MEM_DIR/MEMORY.md";; user) MDFILE="$MEM_DIR/USER.md";; esac
if [ -f "$MDFILE" ] && command -v python3 >/dev/null; then
  # ── cross-process .md lock (Workstream B) ────────────────────────────────
  # MemoryStore wraps loadFromDisk→saveToDisk in a proper-lockfile advisory
  # lock whose lockfile is a DIRECTORY `<mdPath>.lock` (mtime-proven liveness,
  # stale after 10s). Acquire the SAME directory lock here so this trim can't
  # race a live session's write (lost-update). Acquire retries — a session
  # write is sub-second; a holder stuck >10s is stale (crashed) and gets broken.
  # BSD stat (-f %m) — Apple Silicon only, per repo platform.
  LOCK="$MDFILE.lock"; _tries=0
  until mkdir "$LOCK" 2>/dev/null; do
    _tries=$((_tries+1))
    if [ $_tries -gt 200 ]; then
      echo "  ⚠ .md lock held >20s by another process — aborting trim to avoid a lost-update race." >&2
      echo "    DB rows NOT deleted. Re-run dedup when no session is mid-write (or after restart). Backup: $BAK" >&2
      exit 1
    fi
    if [ -d "$LOCK" ]; then
      _mt=$(stat -f %m "$LOCK" 2>/dev/null || echo 0)
      [ $(( $(date +%s) - _mt )) -ge 10 ] && { rmdir "$LOCK" 2>/dev/null || rm -rf "$LOCK"; continue; }
    fi
    sleep 0.1
  done
  set +e
  python3 - "$MDFILE" "$DB" "$TARGET" "$([ "$PRUNE_STUBS" = 1 ] && echo 1 || echo 0)" "$STUB_MAXLEN" "$MANIFEST" <<'PY'
import sys, sqlite3, pathlib, shutil, time
mdfile, db, target, prune_stubs, stub_max, manifest = sys.argv[1:7]
prune_stubs = int(prune_stubs); stub_max = int(stub_max)
con = sqlite3.connect(db)
rows = con.execute("SELECT content FROM memories WHERE target=?", (target,)).fetchall()
con.close()
def md_cand(c):
    if c.startswith(("[REMOVED", "[MERGED-PLACEHOLDER")) or c.startswith("REMOVED —"): return True
    if prune_stubs and (c.startswith("[bash error]") or c.startswith("[failure] [bash error]") or len(c) < stub_max): return True
    return False
prefixes = tuple({c[:60] for (c,) in rows if md_cand(c)})
p = pathlib.Path(mdfile)
shutil.copy(p, str(p)+".bak-md-%d" % int(time.time()))
text = p.read_text()
parts = text.split("\n§\n")
removed = [e for e in parts if e.lstrip().startswith(prefixes)]
kept = [e for e in parts if not e.lstrip().startswith(prefixes)]
new = "\n§\n".join(kept)
if not text.rstrip().endswith("§") and new.rstrip().endswith("§"): new = new.rstrip()[:-1]
p.write_text(new)
with open(manifest, "a") as f:
    for e in removed: f.write("MD-entry\t" + e.replace("\n"," ")[:120] + "\n")
print(f"▸ .md source trim: {len(parts)} -> {len(kept)} §-entries (removed {len(removed)}) [{p.name}]")
PY
  _py_rc=$?
  set -e
  rmdir "$LOCK" 2>/dev/null || rm -rf "$LOCK"
  if [ $_py_rc -ne 0 ]; then echo "  ⚠ .md trim python failed (rc=$_py_rc) — lock released, DB rows NOT deleted." >&2; exit $_py_rc; fi
else
  echo "  ⚠ python3 or $MDFILE missing — .md NOT trimmed; DB deletes WILL re-hydrate. Trim $MDFILE manually." >&2
fi

# append DB rows being deleted to the manifest
{ [ -n "$hard_ids" ] && printf '%s\n' "$hard_ids"; \
  [ "$PRUNE_STUBS" = 1 ] && [ -n "$stub_ids" ] && printf '%s\n' "$stub_ids"; true; } \
  | sort -n | awk 'NF' | sort -u | while read -r rid; do
  sqlite3 -separator $'\t' "$DB" \
    "SELECT id, COALESCE(category,''), length(content), substr(replace(replace(content,char(10),' '),char(13),' '),1,90) FROM memories WHERE id=$rid;"
done >> "$MANIFEST"
echo "▸ manifest: $MANIFEST"

# DELETE via WITH-clause (re-derives the sets transactionally).
PRUNE_CLAUSE=""
[ "$PRUNE_STUBS" = 1 ] && PRUNE_CLAUSE=", stubs AS (SELECT id FROM memories WHERE target='$TARGET' AND (content LIKE '[bash error]%' OR content LIKE '[failure] [bash error]%' OR length(content) < $STUB_MAXLEN))"
sqlite3 "$DB" <<SQL
BEGIN;
WITH tombstones AS (
  SELECT id FROM memories WHERE target='$TARGET'
    AND (content LIKE '[REMOVED%' OR content LIKE 'REMOVED —%' OR content LIKE '[MERGED-PLACEHOLDER%')
),
dup_losers AS (
  SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY content ORDER BY length(content) DESC, id DESC) rn FROM memories WHERE target='$TARGET') WHERE rn > 1
)$PRUNE_CLAUSE
DELETE FROM memories WHERE id IN (
  SELECT id FROM tombstones UNION SELECT id FROM dup_losers$([ "$PRUNE_STUBS" = 1 ] && echo " UNION SELECT id FROM stubs")
);
COMMIT;
SQL

# ── verify FTS integrity ────────────────────────────────────────────────────
AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memories WHERE target='$TARGET';")
AFTER_CHARS=$(sqlite3 "$DB" "SELECT COALESCE(sum(length(content)),0) FROM memories WHERE target='$TARGET';")
orphans=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memory_fts f LEFT JOIN memories m ON m.id=f.rowid WHERE m.id IS NULL;")
fts_total=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memory_fts;")
mem_total=$(sqlite3 "$DB" "SELECT COUNT(*) FROM memories;")
echo "▸ AFTER: rows=$AFTER  chars=$AFTER_CHARS  (removed $((BEFORE-AFTER)) rows, $((BEFORE_CHARS-AFTER_CHARS)) chars)"
echo "▸ FTS: orphans=$orphans  (must be 0)   memory_fts=$fts_total  memories=$mem_total  (must match)"
if [ "$orphans" != 0 ] || [ "$fts_total" != "$mem_total" ]; then
  echo "  ⚠ FTS INTEGRITY CHECK FAILED — restore from $BAK" >&2; exit 1
fi

# ── prune old backups (keep newest KEEP_BACKUPS of dedup/consolidate) ────────
pruned=$( { ls -1t "$DB".bak-dedup-* "$DB".bak-consolidate-* 2>/dev/null || true; } | tail -n +$((KEEP_BACKUPS + 1)) | wc -l | tr -d ' ')
if [ "$pruned" -gt 0 ]; then
  { ls -1t "$DB".bak-dedup-* "$DB".bak-consolidate-* 2>/dev/null || true; } | tail -n +$((KEEP_BACKUPS + 1)) | xargs rm -f
  echo "▸ pruned $pruned old backup(s) (kept newest $KEEP_BACKUPS)"
fi
echo "▸ done. (note: a running agent's in-memory capacity counter may stay stale until restart — the on-disk DB is clean.)"
