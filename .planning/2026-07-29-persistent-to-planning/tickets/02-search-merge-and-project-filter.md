# 02 — Search/index merge + project-filter semantics

---
type: grilling
status: closed
claimed: wayfinder-session
---

## Question

Once project memory lives in `.planning/memory/MEMORY.md`, how does the DB index BOTH stores, and how does `memory_search` merge project-local + global results? And the project-filter interaction: project-local entries are implicitly project-scoped (no per-entry tag) — do global-store entries still project-tagged surface alongside?

## What to build

A grilled decision on the merge model + filter semantics. Candidates:

- **Single DB, two sources**: index both MEMORY.md files (global + `.planning/memory/`) into one DB; search merges naturally. Project filter returns project-local (implicit) + global-project-tagged.
- **Tag project-local on index**: when indexing `.planning/memory/`, stamp entries with the project name so the EXISTING project filter works unchanged (project-local entries are searchable the same way as global-project-tagged ones).
- **Separate indexes**: keep project-local + global as separate searchable sets; merge at query time. More machinery, isolates the stores.

## Acceptance

- [x] Index/merge model chosen (single-DB-two-sources vs tag-on-index vs separate-indexes), with rationale.
- [x] project-filter semantics decided (does project-local need a tag at index time? do global project-tagged entries still surface alongside?).
- [x] Notes implications for `sync-markdown-memories` (must index `.planning/memory/` too) — tickets 04/05 depend.

## Resolution

**Model: single DB, tag project-local on index** — index `.planning/memory/` entries into the EXISTING single DB, tagged with the project name (same cwd/repo derivation as global project-tagged entries). The existing `memory_search(project=X)` then merges project-local + global-project-tagged naturally. No schema change, no source column, no separate index.

**Rationale**: the DB ALREADY uses a `project` field (`repository.ts` L12) and `syncMemoryEntry` ALREADY takes a `project` param (L50) — the single-DB-tag model is native to the architecture, not new machinery. Rejected: **source column** (reads don't need provenance — writes/migration read the markdown directly, so the cost buys nothing read-side); **separate per-store indexes** (doubles index management + query-merge logic for no read-side benefit).

**project-filter semantics**: project-local entries are tagged with the project name at index time (cwd/repo derivation, same as global). `memory_search(project=X)` returns ALL entries tagged X — global-project-tagged still surface alongside project-local (the DB is source-agnostic). `memory_search` without a project filter surfaces project-local too (same DB). Edge case — same project worked from two checkouts: both `.planning/memory/` sets tagged X → merged in the DB; fine.

**sync-markdown-memories implication (tickets 04/05 depend)**: the handler gains a SECOND source scan — `.planning/memory/MEMORY.md` (when `projectMemoryDir` is set per ticket 01) — calling `syncMemoryEntry` with the project name per entry. The project-name derivation is reused from the existing orchestrator (`memory-tool.ts`). No new filter/query code: the existing `project` filter already does the merge.

*(Resolves ticket 02; graduates the map's "project-filter semantics" fog. Both of ticket 04's blockers — 01, 02 — are now closed, so 04 becomes takeable; frontier becomes {03, 04}.)*
