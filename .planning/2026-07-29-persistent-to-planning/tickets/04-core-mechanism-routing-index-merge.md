# 04 — Core mechanism: write-path routing + indexing + search merge

---
type: task
blocked by: 01, 02
status: open
---

## Question

Implement the core mechanism decided by tickets 01 + 02: route `project`-target writes to `.planning/memory/MEMORY.md` (per 01's resolution), index it into the DB alongside the global store, and merge in `memory_search` (per 02's model). TDD.

## What to build

- Per-target dir resolution in `memory-store.ts` (project → `projectMemoryDir` per ticket 01; user/memory/failure unchanged → global).
- The write path (`add` / `replace` / `remove`) routes project writes to `.planning/memory/MEMORY.md` with the proper-lockfile advisory lock (must work on the new dir — verify the consolidator child + lock path).
- `sync-markdown-memories` + the index/rebuild path pick up `.planning/memory/MEMORY.md` (per ticket 02's merge model).
- Tests (TDD): project write lands in `.planning/memory/`; global targets unchanged; `memory_search` merges both per ticket 02.

## Acceptance

- [ ] `project`-target writes persist to `.planning/memory/MEMORY.md`; other targets unchanged.
- [ ] DB indexes `.planning/memory/` + global; `memory_search` merges both per ticket 02.
- [ ] proper-lockfile works on the new dir (no concurrency regression; consolidator child still functions).
- [ ] TDD: RED→GREEN; full hermes suite green (the pre-existing failures stay unchanged).
