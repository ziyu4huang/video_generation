> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 5d stable-id + .md metadata format migration to YAML frontmatter

## Destination

Migrate every `.md` memory entry's metadata into a **YAML frontmatter** block (retiring the HTML-comment hack), with a **stable id** (`crypto.randomUUID()`) as the anchor field — so DB↔.md matching moves off 5b's fragile **content-key bridge** (dup ambiguity + breaks on body edit) onto **id-based matching**, and `.md` becomes natively parseable by Obsidian / YAML-native tooling. **Status / lineage stay DB-only** — the frontmatter carries id + the existing metadata (created/last/provenance/sources/memworth), not the full read-side. Migration is **lazy**, riding on backfill (one per-entry pass assigns the id + rewrites to frontmatter), with a dual-shape parser bridging the transition. End state: content-key matching in `syncEvictions`/`removeExactSyncedMemories` is replaced (or consciously retained as a fallback) by id-based matching, the HTML comment is retired, and the legacy read-path is deleted.

## Notes

- **Domain**: `bun-apps/pi-agent-ext-hermes-memory/`. `.md` is the human-readable source of truth; today each §-delimited entry carries a trailing `<!-- created=…, last=… -->` (+ optional `<!-- meta:{…} -->`) produced/parsed by `serializeMetadataComment`/`parseMetadataComment` in `src/store/memory-format.ts`, stripped from the body by `stripMetadata`. The DB (SQLite + Surreal) holds status / supersession / lineage / FTS as the read-side. 5b (merged, PR #961) bridges them via content-key matching.
- **Pivot (ticket 00)**: the home choice expanded the destination — 5d is now a **format migration** (HTML comment → YAML frontmatter) *plus* the stable id, not "add id" alone. Driver: standard/tooling parseability. Scope handled via **lazy migration** (no big-bang). This is a project-scoped decision → record in hermes-memory CONTEXT.md/ADR when implementation lands.
- **Skills every session should consult**: `grilling` + `domain-modeling` (ubiquitous language: "stable id", "frontmatter", "content-key", "backfill", "idempotent re-sync", "dual-shape"), `writing-plans` (once the map clears). 5b capacity-loop reference: `docs/superpowers/plans/2026-07-30-hermes-memory-consolidation-lineage-coupling.md`.
- **Standing preferences**: one ticket per session; decisions, not deliverables (planning-by-default); TDD + dual-backend parity (SQLite + Surreal) on any code that follows.

## Decisions so far

- [The .md identity model](tickets/00-md-identity-model.md) — id = `crypto.randomUUID()` (uuid v4, zero-dep, immutable); home = YAML frontmatter migrate-everything (retire the HTML comment), driven by tooling parseability; lazy migration riding on backfill; FTS/content-key safety confirmed by construction.
- [Dual-backend id reconciliation](tickets/02-dual-backend-id-reconciliation.md) — md_id is **agnostic/portable** (uuid v4 from 00), a secondary unique-indexed TEXT column/field on both backends (SQLite `md_id TEXT` + unique idx; Surreal `md_id` field + `UNIQUE` `DEFINE INDEX`); existing PK + lineage refs unchanged and stay DB-only; nullability timeline defers to ticket 01's lazy-vs-eager backfill call. (Resolves the cross-vault portability fog.)
- [Capacity-loop & lineage interaction](tickets/03-capacity-loop-and-lineage-interaction.md) — **id-lifecycle contract**: ids born (uuid), **immutable** through life incl. supersession, **die tracelessly** on consolidation (merged = fresh uuid; consumed DB row + md_id hard-deleted) and on offload (D2 + vault-offload floor both delete DB row + md_id via `syncEvictionsFromSqlite`). Correction: vault-offload deletes the DB row (eviction, not archival-in-place); the `.knowledge.jsonl` archive carries the retired md_id as provenance only (not a join key). Contract → tests in the impl plan.
- [Backfill & migration](tickets/01-backfill-and-migration.md) — **eager one-shot idempotent** backfill on startup (rides `normalizeLegacyMemoryIds`), per-entry atomic `.md` rewrite + DB `md_id` write matched by content-key (new uuid mirrored to both sides; neither wins); idempotent skip on "frontmatter + has-id"; resume-safe on mid-vault death. `md_id` nullable-during-pass → NOT NULL after (+1-release safety net). Edge cases: distinct uuids for content-key dups (dedup post-backfill); `.md`-only entries get uuid now, DB row on next sync. Unblocks ticket 04 (retire content-key bridge) on a clean "everything has md_id" state.
- [Retire content-key bridge](tickets/04-retire-content-key-bridge.md) — **FULL REPLACE** (destination ticket): content-key retired entirely from the steady-state bridge, `md_id` is the only join key across all `removeExactSyncedMemories` callers (syncEvictionsFromSqlite + syncEvictions helpers × evicted/offloaded/transfer) + the store `.md`-side purge. Cutover = ticket 01's eager backfill (no id-less stragglers in steady state). Backfill is the sole transient content-key user, retired post-pass. **Map complete (7/7) → writing-plans.**
- [Frontmatter field schema](tickets/05-frontmatter-field-schema.md) — `id`→`created`→`last`→`provenance`→`sources`→`memworth{success,fail}`; native YAML shapes; omit absent/empty fields; `id` required post-backfill; renames `lastReferenced`→`last`, `mwSuccess`/`mwFail`→`memworth.{success,fail}`.
- [Dual-shape transition parser](tickets/06-dual-shape-transition-parser.md) — `§` delimiter (`"\n§\n"`) never collides with frontmatter (verified empirically); detection = matched `---` fence pair at entry top (robust vs `---`-prefixed bodies); round-trip clean; `stripMetadata` drops frontmatter like the comment (FTS/content-key parity); legacy read-path retired at backfill completion + 1-release safety net.

## Not yet specified

- **Frontmatter ↔ Obsidian `#tags` / links**: if entries become Obsidian-native frontmatter, do we also gain/owe tag/link conventions? Likely out of scope (no current need) but worth a glance when the schema (05) is pinned.

## Out of scope

- **phase-2 semantic / vector recall** — eval-gated; a separate effort.
- **4 non-blocking minors from 5b/5c** (Task-1 `all.length>=2` looseness; Task-4 assertion (b); path 2/3 orphan-test coverage; pre-existing flaky lock tests) — clear, fog-less backlog; small PR or fold into 5d's implementation plan.
- **Moving status / lineage (supersedes / supersededBy / parentIds) into `.md`** — the DB read-side stays authoritative for status/lineage; frontmatter carries id + metadata only.
- **Retiring the DB read-side / making `.md` the complete lineage source** — out; status stays DB-only.
