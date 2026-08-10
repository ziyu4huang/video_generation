# Wayfinder map: 2026-07-29-persistent-to-planning

> **Status: COMPLETE ✅** — all 5 tickets closed, destination reached. Project memory now persists as the markdown SoT in `<cwd>/.planning/memory/`, coexisting with the global store; the DB indexes both; `memory_search` merges.
>
> **📍 Location relocated 2026-08-01 (PR TBD)** — the SoT moved `<cwd>/.planning/memory/` → `<cwd>/.agents/memory/` (semantic split from hand-authored `.planning/`; `.claude/memory` symlink for claude-code discoverability). The split mechanism from this map — config knob `projectMemoryDir`, single-DB tag-on-index merge — is **unchanged**; only the default path moved. Recorded here as a course-correction, not a reversal of the mechanism.

## Destination

Make hermes **`project`-target memory** persist as the markdown source-of-truth in the repo's **`.planning/memory/`** — git-trackable, PR-reviewable, per-repo — coexisting with the global `~/.pi/agent` store (`user`, global `memory` notes, and `failure` stay global). The DB indexes both stores; `memory_search` merges project-local + global results. This relocates the project memory's source-of-truth from the global store into the repo.

## Notes

- **Domain**: the hermes memory system — markdown `.md` is ALREADY the source-of-truth (the DB is only a search index, rebuilt via `sync-markdown-memories`). Key files: `src/store/memory-store.ts` (memoryDir + per-target file resolution at L251-258 — ALL targets share one dir today), `src/handlers/sync-markdown-memories.ts` (Markdown→DB import), `src/paths.ts` (AGENT_ROOT = `~/.pi/agent`).
- **Key fact**: `memoryDir` is already configurable (`config.memoryDir ?? ~/.pi/agent/pi-hermes-memory`), but ALL targets share it — routing `project` to a separate `.planning/memory/` needs NEW per-target dir resolution.
- **Skills every session should consult**: wayfinder, grilling + domain-modeling (resolve tickets), test-driven-development + systematic-debugging (the memory store is lock/IO-sensitive — `proper-lockfile` advisory locks, consolidator child process).
- **Concurrency**: last-write-wins on `.planning/` (wayfind ADR-0005); the memory-store's proper-lockfile must work on `.planning/memory/` too.
- **Scope lock**: `project` target only. `user` / global `memory` / `failure` stay global (failure is the shared cross-project lessons store — splitting it per-repo would fragment learning).

## Decisions so far

- [Project-memory-dir resolution mechanism](tickets/01-project-memory-dir-resolution.md) — **config knob `projectMemoryDir`**, default `<cwd>/.planning/memory/`; `null`/empty falls back to the global store (explicit opt-out). cwd-relative anchoring. Write-path (ticket 04): per-target resolution gains `if target=project && projectMemoryDir set → <projectMemoryDir>/MEMORY.md else global`.
- [Search/index merge + project-filter semantics](tickets/02-search-merge-and-project-filter.md) — **single DB, tag project-local on index**; the existing `memory_search(project=X)` merges project-local + global-project-tagged (DB is source-agnostic). sync-markdown-memories scans `.planning/memory/` as a second source. No schema change.
- [Migration of existing project-tagged entries](tickets/03-migration-of-existing-entries.md) — **leave (no migration)**; existing entries stay global, surface via the search merge. Zero data-movement risk. Ticket 05 → no-op + regression test.
- [Core mechanism: routing + indexing + search merge](tickets/04-core-mechanism-routing-index-merge.md) — **shipped**. Routing already existed (`projectStore`); added `resolveProjectStoreDir()` pure resolver (default `<cwd>/.planning/memory/`, null→legacy, string→path) + `projectMemoryDir` config + sync-markdown-memories in-repo second-source scan. tsc clean, 785/0.
- [Migration implementation + end-to-end coverage](tickets/05-migration-and-end-to-end-coverage.md) — **no-op migration (decision 03 = leave) + merge-pin regression test**. Legacy global + in-repo project entries both surface in one search; the split works end-to-end.

<!-- frontier = (none) — MAP COMPLETE: all 5 tickets closed -->

## Not yet specified

<!-- "project-filter semantics under the split" graduated — resolved by ticket 02 (single DB, tag on index; global-project-tagged surface alongside project-local). -->

## Out of scope

- Relocating `user`, global `memory`, or `failure` targets to `.planning/` (they stay global — user follows the user; failure is the shared cross-project store).
- Changing the §-delimited `MEMORY.md` format (keep it for consistency + round-trip with the global store).
- The L2 knowledge-card (Zettelkasten) and L3 skills layers — this effort is L1 hermes memory only.
