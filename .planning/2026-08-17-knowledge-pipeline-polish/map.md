---
status: complete
---

# Knowledge pipeline polish — 2026-08-17

## Destination
Land the four decided levers from the wayfind map (closed → ../done/2026-08-17-knowledge-pipeline-simplify/) exactly per spec.md: L1 CLI retirement, L2 leaf hoist, L3 trivia, L4 docs truth — zero behavior change, all structure targets verifiable green, merged to main.

## Notes
- Spec is LOCKED — see spec.md (decisions censuses 01–03 + grilling 04–06; do not re-litigate).
- Untouchable (spec risk boundary): card md format/naming, vault layout, store schemas, event contracts, pinned surfaces (hermes 6-tool ≤2100 tok; zk 4 tools), hierarchy goldens.
- Each lever = independent commit slice on ONE feature branch (feat/knowledge-pipeline-polish); squash PR; gates per package.
- Census facts live in ../done/2026-08-17-knowledge-pipeline-simplify/tickets/ (01 docs drift, 02 dead code, 03 redundancy) — cite them, don't re-derive.
- Conventions: scoped git add NEVER -A; .agents/memory/MEMORY.md never committed with features; tickets closed by appending `## Resolution`.

## Decisions so far
- [Charter](tickets/00-charter.md) — execute spec immediately (user pick at closing ceremony).

## Not yet specified
- (none — spec locked)

## Out of scope
- Per spec: package merging/re-tiering, LOC targets, tool-surface changes, fat-file splits, behavior changes, new dependencies.

## Cross-effort links
- **Built-on-by**: `.planning/2026-08-22-context-lifecycle` — this effort's L2 leaf-hoist
  (`s2-agent-core-interface/src/embedding-leaf.ts`) is the single point that effort's D3
  (canonical BGE-M3) changes; its "zero behavior change" fence is exactly what that
  effort's D0 (breaking changes allowed in obsidian + knowledge-card) lifts, by user call.
