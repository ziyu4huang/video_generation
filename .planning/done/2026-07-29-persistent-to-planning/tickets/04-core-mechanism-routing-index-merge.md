# 04 — Core mechanism: write-path routing + indexing + search merge

---
type: task
blocked by: 01, 02
status: closed
claimed: wayfinder-session
---

## Question

Implement the core mechanism decided by tickets 01 + 02: route `project`-target writes to `.planning/memory/MEMORY.md` (per 01's resolution), index it into the DB alongside the global store, and merge in `memory_search` (per 02's model). TDD.

## What to build

- Per-target dir resolution in `memory-store.ts` (project → `projectMemoryDir` per ticket 01; user/memory/failure unchanged → global).
- The write path (`add` / `replace` / `remove`) routes project writes to `.planning/memory/MEMORY.md` with the proper-lockfile advisory lock (must work on the new dir — verify the consolidator child + lock path).
- `sync-markdown-memories` + the index/rebuild path pick up `.planning/memory/MEMORY.md` (per ticket 02's merge model).
- Tests (TDD): project write lands in `.planning/memory/`; global targets unchanged; `memory_search` merges both per ticket 02.

## Acceptance

- [x] `project`-target writes persist to `.planning/memory/MEMORY.md`; other targets unchanged.
- [x] DB indexes `.planning/memory/` + global; `memory_search` merges both per ticket 02.
- [x] proper-lockfile works on the new dir (no concurrency regression; consolidator child still functions).
- [x] TDD: RED→GREEN; full hermes suite green (785 pass / 0 fail).

## Resolution

**Discovery — the routing already existed.** `registerMemoryTool` already takes a separate `projectStore: MemoryStore | null` and routes `target==="project"` to it; `index.ts` already built `projectStore` from `project.memoryDir` (legacy `~/.pi/agent/projects-memory/<project>/`). So ticket 04 was NOT "add routing" — it was **redirect the project store dir to `.planning/memory/`** + wire the search-merge second source.

**Implementation:**
- `resolveProjectStoreDir(projectMemoryDir, detected, cwd)` — **pure resolver** in `project.ts` (decision 01): default `<cwd>/.planning/memory/`; `null` → legacy global; explicit string → that path (cwd-relative). Unit-tested (5 cases: default-in-repo, no-project→null, null→legacy, absolute, relative).
- `projectMemoryDir?: string | null` added to `MemoryConfig` (`types.ts`) + parsed in `loadConfig` (`config.ts`): `null` → opt-out, string → stored raw (cwd-resolved later), absent → default.
- `index.ts`: `projectStore` now uses `resolveProjectStoreDir(...)` (computed early, before the startup sync); the in-repo `MEMORY.md` is passed to all 3 `syncMarkdownMemories` call sites (startup, backend-switch, command).
- `sync-markdown-memories.ts`: `syncMarkdownMemories` + the command gain `inRepoProjectFile`/`inRepoProjectName` params → imports the in-repo file tagged with the project name (decision 02 merge). Skipped when `projectMemoryDir===null` (opt-out) since `scanProjectDirs` already covers the legacy location.

**Verification:** tsc clean; project+config 48/0; full hermes suite **785 pass / 0 fail**; new sync integration test (in-repo `.planning/memory/MEMORY.md` → tagged with project → searchable via `getMemories({project})`).

**lockfile:** unchanged — `MemoryStore`'s proper-lockfile + consolidator child operate on the `.md` in whatever `memoryDir`; works on `.planning/memory/` with no special handling.

*(Resolves ticket 04. Frontier becomes {05}; 05 unblocked.)*
