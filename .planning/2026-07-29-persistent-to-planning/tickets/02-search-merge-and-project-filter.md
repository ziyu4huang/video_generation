# 02 — Search/index merge + project-filter semantics

---
type: grilling
status: open
---

## Question

Once project memory lives in `.planning/memory/MEMORY.md`, how does the DB index BOTH stores, and how does `memory_search` merge project-local + global results? And the project-filter interaction: project-local entries are implicitly project-scoped (no per-entry tag) — do global-store entries still project-tagged surface alongside?

## What to build

A grilled decision on the merge model + filter semantics. Candidates:

- **Single DB, two sources**: index both MEMORY.md files (global + `.planning/memory/`) into one DB; search merges naturally. Project filter returns project-local (implicit) + global-project-tagged.
- **Tag project-local on index**: when indexing `.planning/memory/`, stamp entries with the project name so the EXISTING project filter works unchanged (project-local entries are searchable the same way as global-project-tagged ones).
- **Separate indexes**: keep project-local + global as separate searchable sets; merge at query time. More machinery, isolates the stores.

## Acceptance

- [ ] Index/merge model chosen (single-DB-two-sources vs tag-on-index vs separate-indexes), with rationale.
- [ ] project-filter semantics decided (does project-local need a tag at index time? do global project-tagged entries still surface alongside?).
- [ ] Notes implications for `sync-markdown-memories` (must index `.planning/memory/` too) — tickets 04/05 depend.
