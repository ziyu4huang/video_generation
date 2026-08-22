---
name: pi-memory-bulk-dedup
description: "Bulk-dedup a bloated pi memory target (failure/memory/user) — edits the .md source-of-truth (not just the DB) so deletions survive re-hydration. Ships with dedup.ts; dry-run + backup + FTS verify before any destructive apply."
version: 3
created: 2026-06-28
updated: 2026-08-07
---

## ⚠️ Architecture (read first — v1/v2 of this skill got it BACKWARDS)
The per-target **`.md` files are the SOURCE OF TRUTH**, not the DB:
- `failures.md` / `MEMORY.md` / `USER.md` — flat files under
  `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-hermes-memory/`, entries delimited
  by a line containing only `§`, each entry = `[category] text … <!-- created=DATE, last=DATE -->`.
- `memories` table (`sessions.db`, same dir) — a **hydrated search index**,
  re-populated from the `.md` on harness activity.

**Consequence (proven 2026-07-10):** deleting rows from the DB does NOT stick — the harness re-hydrates them from the `.md` with fresh ids. A DB-only `--commit` removed 12 rows; within minutes 8 came back as ids 147–154. **DB-only dedup is futile whack-a-mole.** The `.md` MUST be edited. (This directly refutes this skill's own v1, which claimed the `.md` was "non-authoritative" and recommended a `bun -e` DB-only canonicalizer — it was the opposite, and that advice caused the re-fragmentation. v3 drops the inline `bun -e` approach entirely.)

## When to Use
A target is full / rejecting `memory add`, AND a dry-run shows real duplicate/tombstone/stub rows. **First check WHY:** if the dry-run's HARD-DELETE finds nothing, the bloat is *verbosity, not duplication* — dedup won't help; trim/condense long entries or `memory transfer` them to the vault instead.

## Procedure (automated — PREFER THIS)
`dedup.ts` sits **beside this `SKILL.md`** and operates **`.md`-first**: it detects candidate rows in the DB, then on `--commit` trims the matching `§`-entries from the target `.md` (backup first) AND deletes the DB rows — so the deletion survives re-hydration.

Store paths (`sessions.db`, the per-target `.md`, backups, the `.md.lock`, the `.tsv` manifest) **all default to the agent-root memory dir** `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-hermes-memory/` — the script derives them from the agent root, **never from its own location**, so it works unchanged from a repo worktree, a `--bundle` deploy, or an extracted `--exe` binary. Override the DB (and its co-located `.md` set) with `--db` / `$PI_MEMORY_DB`; select the target with `--target {failure|memory|user}`.

```bash
DEDUP=bun-apps/s2-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/dedup.ts

bun "$DEDUP" --target failure                          # 1. DRY-RUN (prints plan, changes nothing)
bun "$DEDUP" --target failure --commit                 # 2. APPLY safe hard-deletes (.md + DB)
bun "$DEDUP" --target failure --prune-stubs --commit   # 3. also prune [bash error]/short stubs
```

`--commit` order: concurrency check → back up **both** `.md` and `sessions.db` → `PRAGMA wal_checkpoint(TRUNCATE)` → trim matching `§`-entries from `<target>.md` (writes a `dedup-removed-<target>-<ts>.tsv` manifest next to the DB) → DELETE the DB rows → verify FTS (orphans=0, `memory_fts`==`memories`). Exits non-zero if FTS is corrupt, naming the backup to restore. The default is **DRY-RUN** — nothing is written unless `--commit` is passed.

## Two-tier safety
- **HARD-DELETE** (always safe, applied by `--commit`): exact-content duplicates + tombstones (`[REMOVED …]`/`[MERGED-PLACEHOLDER-*]`). Byte-identical re-inserts — lose nothing.
- **REPORT-ONLY** (never auto-deleted): near-dup clusters + `[bash error]`/short stubs. These may encode real lessons. Add `--prune-stubs` to also remove stub rows **after eyeballing the dry-run**.

Flags: `--target {failure|memory|user}`, `--db <path>`, `--commit`, `--prune-stubs`, `--keep-backups N` (default 5), `--prefix-len N` (near-dup key, default 80), `--stub-maxlen N` (default 120). `bun dedup.ts --help` prints the full reference.

## Procedure (manual fallback)
If `dedup.ts` is unavailable, the `.md` trim is the essential step. Back up, then filter `§`-entries:
```bash
MEM_DIR=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-hermes-memory
DB="$MEM_DIR/sessions.db"
MD="$MEM_DIR/failures.md"   # or MEMORY.md / USER.md
cp "$MD" "$MD.bak-trim-$(date +%s)"
# remove §-entries whose text starts with a noise prefix; KEEP duplicates' canonical (longest) entry
python3 - "$MD" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); text = p.read_text()
deny = ["[failure] [bash error] …", "…"]   # exact entry-start prefixes from your dry-run
parts = text.split("\n§\n")
kept = [e for e in parts if not e.lstrip().startswith(tuple(deny))]
p.write_text("\n§\n".join(kept))
print(f"{len(parts)} -> {len(kept)}")
PY
# THEN sync the DB so it matches the trimmed .md (else it re-hydrates on next access):
sqlite3 "$DB" "DELETE FROM memories WHERE target='failure' AND (content LIKE '[failure] [bash error]%' OR …);"
sqlite3 "$DB" "SELECT COUNT(*) FROM memory_fts f LEFT JOIN memories m ON m.id=f.rowid WHERE m.id IS NULL;"  # must be 0
```

## Pitfalls
- **The `.md` is authoritative.** Editing only the DB is futile (re-hydrates). Always trim the `.md` AND the DB together — which is exactly what `dedup.ts --commit` does.
- **`[bash error]` stubs are mixed quality** — most are transient command failures (wrong cwd, renamed package, git rev) with no durable lesson; but some capture a real gotcha. Before `--prune-stubs`, eyeball the list and confirm each isn't a lesson (or condense the lesson into a proper entry first, then prune the raw stub).
- **Stale in-memory capacity counter:** after `.md`+DB cleanup, the *running* agent's `memory add` may STILL report the target full (in-process counter) until restart. On-disk state is correct; future sessions see the freed space.
- The `memory` tool's `remove`/`replace` cannot see/remove cross-session rows — use `dedup.ts`/SQL, not the API.
- Never run `--commit` while another s2-agent session is live — it races the harness and re-fragments (a root cause of the bloat). The `ps` check warns; `--commit` still proceeds but the `.md` trim is cross-process-locked so it can't lose a live write.
- Leave the per-target `.md` to `dedup.ts`'s structured `§`-filter; never line-edit it blind (you'll corrupt delimiters).

## Verification
1. `dedup.ts` prints BEFORE→AFTER for BOTH `.md` entry count and DB row/char count.
2. FTS orphan check = 0 and `memory_fts` count == `memories` count.
3. **Stickiness:** after a `memory_search`/`memory add`, re-query — deleted rows must NOT reappear (they won't, since the `.md` no longer has them).
4. Backup files + `dedup-removed-*.tsv` manifest exist next to the DB under the agent-root memory dir.
