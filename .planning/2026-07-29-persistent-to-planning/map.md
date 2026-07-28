# Wayfinder map: 2026-07-29-persistent-to-planning

## Destination

Make hermes **`project`-target memory** persist as the markdown source-of-truth in the repo's **`.planning/memory/`** — git-trackable, PR-reviewable, per-repo — coexisting with the global `~/.pi/agent` store (`user`, global `memory` notes, and `failure` stay global). The DB indexes both stores; `memory_search` merges project-local + global results. This relocates the project memory's source-of-truth from the global store into the repo.

## Notes

- **Domain**: the hermes memory system — markdown `.md` is ALREADY the source-of-truth (the DB is only a search index, rebuilt via `sync-markdown-memories`). Key files: `src/store/memory-store.ts` (memoryDir + per-target file resolution at L251-258 — ALL targets share one dir today), `src/handlers/sync-markdown-memories.ts` (Markdown→DB import), `src/paths.ts` (AGENT_ROOT = `~/.pi/agent`).
- **Key fact**: `memoryDir` is already configurable (`config.memoryDir ?? ~/.pi/agent/pi-hermes-memory`), but ALL targets share it — routing `project` to a separate `.planning/memory/` needs NEW per-target dir resolution.
- **Skills every session should consult**: wayfinder, grilling + domain-modeling (resolve tickets), test-driven-development + systematic-debugging (the memory store is lock/IO-sensitive — `proper-lockfile` advisory locks, consolidator child process).
- **Concurrency**: last-write-wins on `.planning/` (wayfind ADR-0005); the memory-store's proper-lockfile must work on `.planning/memory/` too.
- **Scope lock**: `project` target only. `user` / global `memory` / `failure` stay global (failure is the shared cross-project lessons store — splitting it per-repo would fragment learning).

## Decisions so far

<!-- empty — frontier = {01, 02, 03} -->

## Not yet specified

- **project-filter semantics under the split**: once project memory lives in `.planning/memory/` (implicitly project-scoped, no per-entry tag needed), how the existing `memory_search` `project` filter interacts — do global-store entries still project-tagged surface alongside the project-local ones? Sharpens as ticket 02 resolves; may graduate a sub-ticket for edge cases (e.g. the same project worked from two checkouts).

## Out of scope

- Relocating `user`, global `memory`, or `failure` targets to `.planning/` (they stay global — user follows the user; failure is the shared cross-project store).
- Changing the §-delimited `MEMORY.md` format (keep it for consistency + round-trip with the global store).
- The L2 knowledge-card (Zettelkasten) and L3 skills layers — this effort is L1 hermes memory only.
